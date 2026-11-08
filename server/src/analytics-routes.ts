import ExcelJS from 'exceljs';
import { AnalyticsService } from './analytics.js';
import { authorized, response, type Authorizer } from './http.js';

export function analyticsRoutes(service: AnalyticsService, auth: Authorizer) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const match = /^\/api\/relatorios\/(\w+)$/.exec(url.pathname);
    if (request.method !== 'GET' || (!match && url.pathname !== '/api/dashboard')) return response({ erro: 'Rota não encontrada.' }, 404);
    return authorized(request, auth, async () => {
      if (!match) return response(await service.dashboard());
      const name = match[1];
      if (!name) return response({ erro: 'Rota não encontrada.' }, 404);
      const report = await service.report(name, url.searchParams);
      if (url.searchParams.get('formato') !== 'xlsx') return response(report);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Relatório');
      sheet.addRow([report.titulo]).font = { bold: true, size: 14 };
      if (report.periodo) sheet.addRow([`Período: ${report.periodo[0]} a ${report.periodo[1]}`]);
      sheet.addRow([]);
      const header = sheet.addRow(report.colunas.map(col => col.label));
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B1F4D' } };
      for (const row of report.linhas) sheet.addRow(report.colunas.map(col => {
        const value = row[col.key];
        if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
        throw new Error('Valor de relatório incompatível com exportação.');
      }));
      if (Object.keys(report.totais).length) {
        const totals = sheet.addRow(report.colunas.map((col, i) => {
          if (i === 0) return 'TOTAL';
          const value = report.totais[col.key];
          if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
          throw new Error('Total de relatório incompatível com exportação.');
        }));
        totals.font = { bold: true };
      }
      report.colunas.forEach((col, i) => {
        const c = sheet.getColumn(i + 1);
        c.width = Math.max(14, col.label.length + 4);
        if (col.tipo === 'moeda') c.numFmt = '#,##0.00';
      });
      const buffer = await workbook.xlsx.writeBuffer();
      return new Response(new Uint8Array(buffer), { headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}.xlsx"`,
        'Cache-Control': 'no-store',
      } });
    });
  };
}
