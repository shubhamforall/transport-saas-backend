import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { amountInWords } from '../modules/invoices/calc.js';
import { stateLabel } from '../utils/indian-states.js';
import type { toInvoiceDto } from '../modules/invoices/invoices.service.js';

type InvoiceDto = ReturnType<typeof toInvoiceDto>;
type Party = InvoiceDto['billTo'];

// Bundled DejaVu fonts include the ₹ sign. Path works from src/ (tsx) and dist/ (build).
const FONT_REGULAR = fileURLToPath(new URL('../../assets/fonts/DejaVuSans.ttf', import.meta.url));
const FONT_BOLD = fileURLToPath(new URL('../../assets/fonts/DejaVuSans-Bold.ttf', import.meta.url));

const INK = '#172033';
const MUTED = '#64748b';
const LINE = '#e4e9f1';
const BRAND = '#2563eb';

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (paise: number) => `₹${inr.format(paise / 100)}`;
const qty = (milli: number) =>
  milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3).replace(/0+$/, '');
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

function fmtDate(iso: string | null) {
  if (!iso) return '-';
  const [y, m, d] = iso.split('-');
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

function partyLines(p: Party): string[] {
  const cityLine = [p.city, p.state, p.postalCode].filter(Boolean).join(', ');
  return [
    p.legalName && p.legalName !== p.name ? p.legalName : null,
    p.addressLine1,
    p.addressLine2,
    cityLine || null,
    p.gstin ? `GSTIN: ${p.gstin}` : null,
    p.stateCode ? `State code: ${p.stateCode}` : null,
    p.phone ? `Phone: ${p.phone}` : null,
    p.email ?? null,
  ].filter((l): l is string => Boolean(l));
}

/** Renders the invoice to a PDF buffer from persisted data only. */
export function renderInvoicePdf(inv: InvoiceDto): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: inv.invoiceNumber ?? 'Draft invoice' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('R', FONT_REGULAR);
    doc.registerFont('B', FONT_BOLD);
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Watermark for drafts and cancelled invoices.
    const mark = inv.status === 'DRAFT' ? 'DRAFT' : inv.status === 'CANCELLED' ? 'CANCELLED' : null;
    const watermark = () => {
      if (!mark) return;
      doc.save();
      doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('B').fontSize(90).fillColor('#ef4444').opacity(0.12);
      doc.text(mark, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
      doc.restore();
      doc.opacity(1);
    };
    watermark();
    doc.on('pageAdded', watermark);

    // Header: seller + title.
    const title = inv.taxType === 'NONE' ? 'INVOICE' : 'TAX INVOICE';
    doc
      .font('B')
      .fontSize(16)
      .fillColor(INK)
      .text(inv.from.name, left, 40, { width: width * 0.6 });
    doc.font('R').fontSize(8.5).fillColor(MUTED);
    for (const l of partyLines(inv.from)) doc.text(l, { width: width * 0.6 });
    const headerBottom = doc.y;

    doc.font('B').fontSize(18).fillColor(BRAND).text(title, left, 40, { width, align: 'right' });
    doc.font('R').fontSize(9).fillColor(INK);
    const meta: [string, string][] = [
      ['Invoice no.', inv.invoiceNumber ?? 'Draft (number assigned on issue)'],
      ['Invoice date', fmtDate(inv.invoiceDate)],
      ['Due date', fmtDate(inv.dueDate)],
    ];
    if (inv.placeOfSupplyStateCode) {
      meta.push(['Place of supply', stateLabel(inv.placeOfSupplyStateCode) ?? '']);
    }
    for (const [k, v] of meta) doc.text(`${k}: ${v}`, left, doc.y + 2, { width, align: 'right' });

    let y = Math.max(headerBottom, doc.y) + 16;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 12;

    // Bill to.
    doc.font('B').fontSize(9).fillColor(MUTED).text('BILL TO', left, y);
    doc
      .font('B')
      .fontSize(11)
      .fillColor(INK)
      .text(inv.billTo.name, left, doc.y + 2, { width: width * 0.6 });
    doc.font('R').fontSize(8.5).fillColor(MUTED);
    if (inv.billTo.contactPerson) doc.text(`Attn: ${inv.billTo.contactPerson}`);
    for (const l of partyLines(inv.billTo)) doc.text(l, { width: width * 0.6 });
    y = doc.y + 14;

    // Linked jobs.
    if (inv.jobs.length) {
      doc.font('B').fontSize(9).fillColor(MUTED).text('TRANSPORT DETAILS', left, y);
      doc.font('R').fontSize(8.5).fillColor(INK);
      for (const j of inv.jobs) {
        const parts = [
          j.jobNumber,
          `${j.originCity} to ${j.destinationCity}`,
          j.vehicleRegistration ? `Vehicle ${j.vehicleRegistration}` : null,
          j.lrNumber ? `LR ${j.lrNumber}` : null,
          j.actualDeliveryDate ? `Delivered ${fmtDate(j.actualDeliveryDate)}` : null,
        ].filter(Boolean);
        doc.text(parts.join('  ·  '), left, doc.y + 2, { width });
        doc.fillColor(MUTED).text(j.goodsDescription, { width }).fillColor(INK);
      }
      y = doc.y + 14;
    }

    // Line items table.
    const showTax = inv.taxType !== 'NONE';
    const cols = showTax
      ? [
          { key: '#', w: 22, align: 'left' },
          { key: 'Description', w: 0, align: 'left' },
          { key: 'Qty', w: 38, align: 'right' },
          { key: 'Rate', w: 66, align: 'right' },
          { key: 'Disc.', w: 52, align: 'right' },
          { key: 'Taxable', w: 70, align: 'right' },
          { key: 'GST', w: 36, align: 'right' },
          { key: 'Amount', w: 72, align: 'right' },
        ]
      : [
          { key: '#', w: 22, align: 'left' },
          { key: 'Description', w: 0, align: 'left' },
          { key: 'Qty', w: 40, align: 'right' },
          { key: 'Rate', w: 76, align: 'right' },
          { key: 'Disc.', w: 60, align: 'right' },
          { key: 'Amount', w: 82, align: 'right' },
        ];
    const fixed = cols.reduce((s, c) => s + c.w, 0);
    cols[1]!.w = width - fixed;

    const drawRow = (cells: string[], bold: boolean, fill?: string) => {
      doc.font(bold ? 'B' : 'R').fontSize(8.5);
      const heights = cells.map((t, i) => doc.heightOfString(t, { width: cols[i]!.w - 8 }));
      const h = Math.max(...heights) + 10;
      if (y + h > doc.page.height - 120) {
        doc.addPage();
        y = 40;
      }
      if (fill) doc.rect(left, y, width, h).fill(fill);
      let x = left;
      cells.forEach((t, i) => {
        const c = cols[i]!;
        doc.fillColor(bold ? MUTED : INK).text(t, x + 4, y + 5, {
          width: c.w - 8,
          align: c.align as 'left' | 'right',
        });
        x += c.w;
      });
      y += h;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    };

    drawRow(
      cols.map((c) => c.key),
      true,
      '#f8fafc',
    );
    inv.items.forEach((it, i) => {
      const desc = it.sacCode ? `${it.description}\nSAC ${it.sacCode}` : it.description;
      const common = [
        String(i + 1),
        desc,
        qty(it.quantityMilli),
        money(it.unitPriceMinor),
        money(it.discountMinor),
      ];
      drawRow(
        showTax
          ? [...common, money(it.taxableAmountMinor), pct(it.taxRateBps), money(it.lineTotalMinor)]
          : [...common, money(it.lineTotalMinor)],
        false,
      );
    });

    // Totals.
    y += 10;
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 40;
    }
    const totals: [string, string, boolean?][] = [['Subtotal', money(inv.subtotalMinor)]];
    if (inv.discountMinor) totals.push(['Discount', `- ${money(inv.discountMinor)}`]);
    if (showTax) {
      totals.push(['Taxable value', money(inv.taxableMinor)]);
      if (inv.taxType === 'INTRA_STATE') {
        totals.push(['CGST', money(inv.cgstMinor)], ['SGST', money(inv.sgstMinor)]);
      } else {
        totals.push(['IGST', money(inv.igstMinor)]);
      }
    }
    totals.push(['Total', money(inv.grandTotalMinor), true]);
    if (inv.amountPaidMinor > 0) {
      totals.push(
        ['Paid', money(inv.amountPaidMinor)],
        ['Balance due', money(inv.balanceMinor), true],
      );
    }
    const tx = right - 220;
    for (const [label, value, strong] of totals) {
      doc
        .font(strong ? 'B' : 'R')
        .fontSize(strong ? 10.5 : 9)
        .fillColor(INK);
      doc.text(label, tx, y, { width: 110 });
      doc.text(value, tx + 110, y, { width: 110, align: 'right' });
      y += strong ? 17 : 14;
    }
    doc.font('R').fontSize(8.5).fillColor(MUTED);
    doc.text(`Amount in words: ${amountInWords(inv.grandTotalMinor)}`, left, y + 4, { width });
    y = doc.y + 12;

    const block = (heading: string, body: string | null | undefined) => {
      if (!body) return;
      if (y > doc.page.height - 100) {
        doc.addPage();
        y = 40;
      }
      doc.font('B').fontSize(9).fillColor(MUTED).text(heading, left, y);
      doc
        .font('R')
        .fontSize(8.5)
        .fillColor(INK)
        .text(body, left, doc.y + 2, { width });
      y = doc.y + 10;
    };
    block('PAYMENT INSTRUCTIONS', inv.from.paymentInstructions);
    block('NOTES', inv.notes);
    block('TERMS', inv.terms);
    if (inv.status === 'CANCELLED') {
      block('CANCELLED', inv.cancellationReason ?? 'This invoice has been cancelled.');
    }

    doc.font('R').fontSize(7.5).fillColor(MUTED);
    doc.text('This is a computer-generated invoice.', left, doc.page.height - 55, {
      width,
      align: 'center',
    });
    doc.end();
  });
}
