"""Repositório PostgreSQL por requisição, sem estado compartilhado entre workers."""
import copy
import os
import threading
from contextlib import contextmanager

from sqlalchemy import text

from db import SCHEMAS, Store


class ConcurrentUpdateError(RuntimeError):
    """A linha mudou depois de lida; a operação deve ser refeita com dados atuais."""


class PostgresStore:
    def __init__(self, connection, folder):
        self.connection = connection
        self.folder = folder
        self.lock = threading.RLock()
        self._cache = {}
        self._original = {}
        self._versions = {}
        self._dirty = set()
        self._depth = 0

    def path(self, name):
        return os.path.join(self.folder, SCHEMAS[name][0])

    def _load(self, name):
        if name not in self._cache:
            columns = ', '.join(SCHEMAS[name][1])
            result = self.connection.execute(text(
                f'SELECT {columns}, xmin::text AS _version '
                f'FROM public.{name} ORDER BY id'
            )).mappings()
            rows, versions = [], {}
            for record in result:
                row = {column: record[column] for column in SCHEMAS[name][1]}
                for column, value in row.items():
                    if hasattr(value, 'isoformat'):
                        row[column] = value.isoformat()
                rows.append(row)
                versions[row['id']] = record['_version']
            self._cache[name] = rows
            self._original[name] = copy.deepcopy(rows)
            self._versions[name] = versions
        return self._cache[name]

    def all(self, name):
        with self.lock:
            return self._load(name)

    def is_empty(self):
        return not any(self.all(name) for name in SCHEMAS)

    def import_local_if_empty(self):
        if not self.is_empty():
            return False
        local = Store(self.folder)
        found = False
        for name in SCHEMAS:
            path = local.path(name)
            rows = local._read(name, path) if os.path.exists(path) else []
            if rows:
                self._cache[name] = rows
                self._original[name] = []
                self._versions[name] = {}
                self._dirty.add(name)
                found = True
        if found:
            self._flush()
            self.reset_sequences()
        return found

    def reset_sequences(self):
        for name in SCHEMAS:
            sequence = self.connection.execute(text(
                'SELECT pg_get_serial_sequence(:table_name, :column_name)'
            ), {'table_name': f'public.{name}', 'column_name': 'id'}).scalar_one()
            if not sequence:
                raise RuntimeError(f'A tabela "{name}" não possui uma sequência de IDs.')
            maximum = self.connection.execute(text(
                f'SELECT max(id) FROM public.{name}'
            )).scalar_one()
            self.connection.execute(text(
                'SELECT setval(CAST(:sequence_name AS regclass), :last_id, :called)'
            ), {
                'sequence_name': sequence,
                'last_id': maximum or 1,
                'called': maximum is not None,
            })

    def next_id(self, name):
        sequence = self.connection.execute(text(
            'SELECT pg_get_serial_sequence(:table_name, :column_name)'
        ), {'table_name': f'public.{name}', 'column_name': 'id'}).scalar_one()
        if not sequence:
            raise RuntimeError(
                f'A tabela "{name}" não possui uma sequência de IDs. '
                'Execute a migração do schema Supabase atualizada.'
            )
        return self.connection.execute(text(
            'SELECT nextval(CAST(:sequence_name AS regclass))'
        ), {'sequence_name': sequence}).scalar_one()

    def save(self, name):
        with self.lock:
            self._load(name)
            self._dirty.add(name)
            if self._depth == 0:
                self._flush()

    @contextmanager
    def batch(self):
        with self.lock:
            self._depth += 1
            try:
                yield
            except BaseException:
                if self._depth == 1:
                    self._dirty.clear()
                raise
            finally:
                self._depth -= 1
            if self._depth == 0:
                self._flush()

    def _flush(self):
        for name in list(self._dirty):
            self._flush_table(name)
        self._dirty.clear()

    def flush(self):
        with self.lock:
            self._flush()

    def _flush_table(self, name):
        columns = SCHEMAS[name][1]
        original = {row['id']: row for row in self._original[name]}
        current = {row['id']: row for row in self._cache[name]}
        versions = self._versions[name]

        for row_id, row in current.items():
            old = original.get(row_id)
            if old is None:
                names = ', '.join(columns)
                binds = ', '.join(f':{column}' for column in columns)
                version = self.connection.execute(text(
                    f'INSERT INTO public.{name} ({names}) VALUES ({binds}) '
                    'RETURNING xmin::text'
                ), row).scalar_one()
                original[row_id] = copy.deepcopy(row)
                versions[row_id] = version
                continue
            if row == old:
                continue

            assignments = ', '.join(
                f'{column} = :{column}' for column in columns if column != 'id'
            )
            result = self.connection.execute(text(
                f'UPDATE public.{name} SET {assignments} '
                'WHERE id = :id AND xmin::text = :expected_version '
                'RETURNING xmin::text'
            ), {**row, 'expected_version': versions[row_id]})
            version = result.scalar_one_or_none()
            if version is None:
                raise ConcurrentUpdateError(
                    f'O registro {row_id} da tabela "{name}" foi alterado por outro usuário. '
                    'Atualize a tela e tente novamente.'
                )
            original[row_id] = copy.deepcopy(row)
            versions[row_id] = version

        for row_id in original.keys() - current.keys():
            result = self.connection.execute(text(
                f'DELETE FROM public.{name} '
                'WHERE id = :id AND xmin::text = :expected_version'
            ), {'id': row_id, 'expected_version': versions[row_id]})
            if result.rowcount != 1:
                raise ConcurrentUpdateError(
                    f'O registro {row_id} da tabela "{name}" foi alterado por outro usuário. '
                    'Atualize a tela e tente novamente.'
                )
            del original[row_id]
            del versions[row_id]

        self._original[name] = [copy.deepcopy(row) for row in current.values()]
