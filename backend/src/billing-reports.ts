import PDFDocument from 'pdfkit';

type PdfRecord = Record<string, any>;
type Column = { label: string; key: string; width: number; align?: 'left' | 'right' | 'center'; format?: (value: any, row: PdfRecord) => string };

const colors = { ink: '#493740', muted: '#7a6d73', rose: '#b66f8d', blush: '#f3dce5', pale: '#faf5f7', line: '#eadfe3', green: '#5d876f', amber: '#a97725' };
const brand = {
  plum: '#4b3943',
  pink: '#efbfd0',
  white: '#fffaf8',
  ePath: 'M29 33h48v13H44v16h28v12H44v18h35v13H29z',
  lPath: 'M75 59h15v33h22v13H75z'
};
const money = (value: unknown) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
const date = (value: unknown) => {
  if (!value) return '-';
  const text = String(value); const parsed = value instanceof Date
    ? value
    : /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(`${text.slice(0, 10)}T12:00:00-05:00`) : new Date(text);
  return Number.isNaN(parsed.getTime()) ? text.slice(0, 10) : new Intl.DateTimeFormat('es-PA', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Panama' }).format(parsed);
};
const clean = (value: unknown) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const status = (value: unknown) => value === 'confirmed' ? 'Pagada' : value === 'void' ? 'Anulada' : 'Pendiente';

function pdfBuffer(draw: (document: PDFKit.PDFDocument) => void) {
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'LETTER', margin: 42, bufferPages: true, info: { Author: 'Eileen Lifestyle', Creator: 'Eileen Lifestyle' } });
    const chunks: Buffer[] = [];
    document.on('data', chunk => chunks.push(Buffer.from(chunk)));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    draw(document);
    const range = document.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index += 1) {
      document.switchToPage(index);
      const bottomMargin = document.page.margins.bottom;
      document.page.margins.bottom = 0;
      document.font('Helvetica').fontSize(7).fillColor(colors.muted).text(`Eileen Lifestyle · Página ${index + 1} de ${range.count}`, 42, document.page.height - 27, { width: document.page.width - 84, align: 'center', lineBreak: false });
      document.page.margins.bottom = bottomMargin;
    }
    document.end();
  });
}

function brandMark(document: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const scale = size / 128;
  document.save();
  document.roundedRect(x, y, size, size, 28 * scale).fill(brand.plum);
  document.translate(x, y).scale(scale);
  document.circle(93, 35, 13).fill(brand.pink);
  document.path(brand.ePath).fill(brand.white);
  document.path(brand.lPath).fill(brand.pink);
  document.restore();
}

function brandHeader(document: PDFKit.PDFDocument, title: string, subtitle: string) {
  // Keep PDF exports aligned with the canonical PWA artwork in /icon.svg.
  brandMark(document, 42, 38, 38);
  document.font('Helvetica-Bold').fontSize(15).fillColor(colors.ink).text('Eileen Lifestyle', 91, 43);
  document.font('Helvetica').fontSize(8).fillColor(colors.muted).text('Entrenamiento personal y bienestar', 91, 62);
  document.moveTo(42, 91).lineTo(document.page.width - 42, 91).strokeColor(colors.line).stroke();
  document.font('Helvetica-Bold').fontSize(23).fillColor(colors.ink).text(title, 42, 111);
  document.font('Helvetica').fontSize(9).fillColor(colors.muted).text(subtitle, 42, 142);
  document.y = 171;
}

function ensureSpace(document: PDFKit.PDFDocument, height: number, continuedTitle = 'Eileen Lifestyle') {
  if (document.y + height <= document.page.height - 48) return;
  document.addPage();
  document.font('Helvetica-Bold').fontSize(11).fillColor(colors.ink).text(continuedTitle, 42, 38);
  document.moveTo(42, 57).lineTo(document.page.width - 42, 57).strokeColor(colors.line).stroke();
  document.y = 72;
}

function infoPair(document: PDFKit.PDFDocument, label: string, value: string, x: number, y: number, width: number) {
  document.font('Helvetica-Bold').fontSize(7).fillColor(colors.muted).text(label.toUpperCase(), x, y, { width });
  document.font('Helvetica').fontSize(10).fillColor(colors.ink).text(value || '-', x, y + 12, { width });
}

function summaryBoxes(document: PDFKit.PDFDocument, values: Array<{ label: string; value: string }>) {
  const gap = 8; const width = (document.page.width - 84 - gap * (values.length - 1)) / values.length; const y = document.y;
  values.forEach((item, index) => {
    const x = 42 + index * (width + gap);
    document.save().roundedRect(x, y, width, 54, 8).fill(colors.pale).restore();
    document.font('Helvetica').fontSize(7).fillColor(colors.muted).text(item.label.toUpperCase(), x + 10, y + 10, { width: width - 20 });
    document.font('Helvetica-Bold').fontSize(14).fillColor(colors.ink).text(item.value, x + 10, y + 27, { width: width - 20 });
  });
  document.y = y + 70;
}

function table(document: PDFKit.PDFDocument, columns: Column[], rows: PdfRecord[], continuedTitle: string) {
  const startX = 42; const headerHeight = 24; const rowHeight = 29;
  const drawHeader = () => {
    ensureSpace(document, headerHeight + rowHeight, continuedTitle);
    const y = document.y;
    document.save().rect(startX, y, columns.reduce((sum, column) => sum + column.width, 0), headerHeight).fill(colors.blush).restore();
    let x = startX;
    columns.forEach(column => {
      document.font('Helvetica-Bold').fontSize(7).fillColor(colors.ink).text(column.label.toUpperCase(), x + 5, y + 8, { width: column.width - 10, align: column.align || 'left', lineBreak: false });
      x += column.width;
    });
    document.y = y + headerHeight;
  };
  drawHeader();
  rows.forEach((row, rowIndex) => {
    if (document.y + rowHeight > document.page.height - 48) drawHeader();
    const y = document.y; let x = startX;
    if (rowIndex % 2) document.save().rect(startX, y, columns.reduce((sum, column) => sum + column.width, 0), rowHeight).fill('#fdfafb').restore();
    columns.forEach(column => {
      const raw = row[column.key]; const text = column.format ? column.format(raw, row) : clean(raw);
      document.font('Helvetica').fontSize(7.5).fillColor(colors.ink).text(text || '-', x + 5, y + 9, { width: column.width - 10, align: column.align || 'left', height: 14, ellipsis: true, lineBreak: false });
      x += column.width;
    });
    document.moveTo(startX, y + rowHeight).lineTo(x, y + rowHeight).strokeColor(colors.line).lineWidth(.5).stroke();
    document.y = y + rowHeight;
  });
}

export function invoicePdf(invoice: PdfRecord, payments: PdfRecord[]) {
  return pdfBuffer(document => {
    const isPaid = invoice.status === 'confirmed' || Number(invoice.balance_amount || 0) === 0;
    const number = clean(invoice.invoice_number || `EIL-${String(invoice.id).slice(0, 8).toUpperCase()}`);
    brandHeader(document, isPaid ? 'Recibo de pago' : 'Factura', `${number} · Documento comercial no fiscal`);
    const metaY = document.y;
    infoPair(document, 'Cliente', clean(invoice.full_name), 42, metaY, 210);
    infoPair(document, 'Correo', clean(invoice.email || 'No registrado'), 42, metaY + 38, 210);
    infoPair(document, 'Fecha de emisión', date(invoice.issued_on || invoice.created_at), 322, metaY, 110);
    infoPair(document, 'Vencimiento', date(invoice.due_on), 445, metaY, 110);
    infoPair(document, 'Estado', status(invoice.status), 322, metaY + 38, 110);
    infoPair(document, 'Origen', invoice.source_system === 'zoho_invoice' ? 'Zoho Invoice' : 'Eileen', 445, metaY + 38, 110);
    document.y = metaY + 91;
    const items = Array.isArray(invoice.line_items) && invoice.line_items.length ? invoice.line_items.map((item: PdfRecord) => ({
      concept: clean(item.name || item.description || invoice.concept), quantity: Number(item.quantity || 1), amount: Number(item.item_total ?? item.amount ?? item.rate ?? invoice.amount)
    })) : [{ concept: clean(invoice.concept), quantity: 1, amount: Number(invoice.amount) }];
    table(document, [
      { label: 'Concepto', key: 'concept', width: 330 }, { label: 'Cantidad', key: 'quantity', width: 75, align: 'center' }, { label: 'Importe', key: 'amount', width: 123, align: 'right', format: money }
    ], items, `Factura ${number}`);
    document.moveDown(1.2);
    const summaryX = 360; const summaryWidth = 195; const row = (label: string, value: string, bold = false) => {
      const y = document.y; document.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor(colors.ink).text(label, summaryX, y, { width: 95 });
      document.text(value, summaryX + 95, y, { width: 100, align: 'right' }); document.y = y + (bold ? 21 : 17);
    };
    row('Subtotal', money(invoice.subtotal || invoice.amount));
    if (Number(invoice.tax_total || 0)) row('Impuesto', money(invoice.tax_total));
    row('Total', money(invoice.amount), true);
    row('Pagado', money(invoice.paid_amount));
    row('Saldo', money(invoice.balance_amount), true);
    document.y += 10;
    ensureSpace(document, 88, `Factura ${number}`);
    document.save().roundedRect(42, document.y, 513, 72, 9).fill(isPaid ? '#eef6f1' : '#fff8e9').restore();
    const boxY = document.y;
    document.font('Helvetica-Bold').fontSize(9).fillColor(isPaid ? colors.green : colors.amber).text(isPaid ? 'PAGO REGISTRADO' : 'SALDO PENDIENTE', 55, boxY + 12);
    const payment = payments[0] || {};
    document.font('Helvetica').fontSize(8).fillColor(colors.ink).text(`Método: ${clean(payment.method || invoice.payment_method || '-')}   ·   Referencia: ${clean(payment.reference || invoice.payment_reference || '-')}   ·   Fecha: ${date(payment.paid_on || invoice.confirmed_at)}`, 55, boxY + 32, { width: 485 });
    document.fontSize(7).fillColor(colors.muted).text('Este comprobante documenta una operación comercial de Eileen Lifestyle y no constituye una factura fiscal.', 55, boxY + 51, { width: 485 });
    document.y = boxY + 88;
  });
}

export function accountStatementPdf(client: PdfRecord, rows: PdfRecord[], from: string, to: string) {
  return pdfBuffer(document => {
    brandHeader(document, 'Estado de cuenta', `${date(from)} al ${date(to)} · Importes en USD`);
    infoPair(document, 'Cliente', clean(client.full_name), 42, document.y, 245);
    infoPair(document, 'Correo', clean(client.email || 'No registrado'), 310, document.y, 245);
    document.y += 48;
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const paid = rows.reduce((sum, row) => sum + Number(row.paid_amount || 0), 0);
    const balance = rows.reduce((sum, row) => sum + Number(row.balance_amount || 0), 0);
    summaryBoxes(document, [{ label: 'Facturado', value: money(total) }, { label: 'Pagado', value: money(paid) }, { label: 'Saldo', value: money(balance) }]);
    if (!rows.length) return void document.font('Helvetica').fontSize(10).fillColor(colors.muted).text('No hay movimientos en el período seleccionado.');
    table(document, [
      { label: 'Fecha', key: 'issued_on', width: 65, format: date }, { label: 'Factura', key: 'invoice_number', width: 75 }, { label: 'Concepto', key: 'concept', width: 178 },
      { label: 'Facturado', key: 'amount', width: 70, align: 'right', format: money }, { label: 'Pagado', key: 'paid_amount', width: 70, align: 'right', format: money }, { label: 'Saldo', key: 'balance_amount', width: 70, align: 'right', format: money }
    ], rows, `Estado de cuenta · ${clean(client.full_name)}`);
  });
}

export function accountsReceivablePdf(rows: PdfRecord[], asOf: string) {
  return pdfBuffer(document => {
    brandHeader(document, 'Cuentas por cobrar', `Saldos vigentes al ${date(asOf)} · Importes en USD`);
    const total = rows.reduce((sum, row) => sum + Number(row.balance_amount || 0), 0);
    const overdue = rows.filter(row => Number(row.days_overdue) > 0).reduce((sum, row) => sum + Number(row.balance_amount || 0), 0);
    const clients = new Set(rows.map(row => row.client_id)).size;
    summaryBoxes(document, [{ label: 'Saldo total', value: money(total) }, { label: 'Saldo vencido', value: money(overdue) }, { label: 'Clientes', value: String(clients) }]);
    if (!rows.length) return void document.font('Helvetica').fontSize(10).fillColor(colors.muted).text('No existen cuentas por cobrar para la fecha seleccionada.');
    table(document, [
      { label: 'Cliente', key: 'full_name', width: 135 }, { label: 'Factura', key: 'invoice_number', width: 76 }, { label: 'Vence', key: 'due_on', width: 68, format: date },
      { label: 'Antigüedad', key: 'aging', width: 82 }, { label: 'Saldo', key: 'balance_amount', width: 80, align: 'right', format: money }, { label: 'Origen', key: 'source_label', width: 87 }
    ], rows, 'Cuentas por cobrar');
  });
}
