import unittest
from unittest.mock import MagicMock

from db import SCHEMAS
from postgres_store import ConcurrentUpdateError, PostgresStore


def customer(**values):
    row = {column: None for column in SCHEMAS['clientes'][1]}
    row.update({'id': 1, 'nome': 'Cliente', **values})
    return row


class PostgresStoreTests(unittest.TestCase):
    def make_store(self):
        connection = MagicMock()
        return PostgresStore(connection, '/tmp/minierp-test'), connection

    def test_update_uses_row_version_and_refreshes_snapshot(self):
        store, connection = self.make_store()
        original = customer(nome='Antes')
        changed = customer(nome='Depois')
        store._original['clientes'] = [original.copy()]
        store._cache['clientes'] = [changed.copy()]
        store._versions['clientes'] = {1: '12'}
        connection.execute.return_value.scalar_one_or_none.return_value = '13'

        store._flush_table('clientes')

        sql, params = connection.execute.call_args.args
        self.assertIn('xmin::text = :expected_version', str(sql))
        self.assertEqual(params['expected_version'], '12')
        self.assertEqual(params['nome'], 'Depois')
        self.assertEqual(store._original['clientes'][0]['nome'], 'Depois')
        self.assertEqual(store._versions['clientes'][1], '13')

        store._flush_table('clientes')

        self.assertEqual(connection.execute.call_count, 1)

    def test_stale_update_is_rejected(self):
        store, connection = self.make_store()
        store._original['clientes'] = [customer(nome='Antes')]
        store._cache['clientes'] = [customer(nome='Depois')]
        store._versions['clientes'] = {1: '12'}
        connection.execute.return_value.scalar_one_or_none.return_value = None

        with self.assertRaises(ConcurrentUpdateError):
            store._flush_table('clientes')

    def test_stale_delete_is_rejected(self):
        store, connection = self.make_store()
        store._original['clientes'] = [customer()]
        store._cache['clientes'] = []
        store._versions['clientes'] = {1: '12'}
        connection.execute.return_value.rowcount = 0

        with self.assertRaises(ConcurrentUpdateError):
            store._flush_table('clientes')

    def test_insert_records_snapshot_version(self):
        store, connection = self.make_store()
        store._original['clientes'] = []
        store._cache['clientes'] = [customer()]
        store._versions['clientes'] = {}
        connection.execute.return_value.scalar_one.return_value = '21'

        store._flush_table('clientes')

        self.assertEqual(store._original['clientes'][0]['id'], 1)
        self.assertEqual(store._versions['clientes'][1], '21')

    def test_next_id_uses_database_sequence(self):
        store, connection = self.make_store()
        sequence = MagicMock()
        sequence.scalar_one.return_value = 'public.clientes_id_seq'
        next_value = MagicMock()
        next_value.scalar_one.return_value = 22
        connection.execute.side_effect = [sequence, next_value]

        self.assertEqual(store.next_id('clientes'), 22)
        self.assertIn('nextval', str(connection.execute.call_args.args[0]))


if __name__ == '__main__':
    unittest.main()
