/**
 * Invoice arithmetic. Integer paise only; BigInt inside so large quantity x price products
 * never lose precision. Rounding is half-up to the nearest paisa.
 */

export type TaxTypeValue = 'NONE' | 'INTRA_STATE' | 'INTER_STATE';

export interface LineInput {
  quantityMilli: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number;
}

export interface LineResult {
  grossMinor: number;
  discountMinor: number;
  taxableAmountMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  taxAmountMinor: number;
  lineTotalMinor: number;
}

export interface Totals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  taxTotalMinor: number;
  grandTotalMinor: number;
}

/** Largest value a 32-bit INT column holds. */
export const MAX_INT = 2_147_483_647;

export class CalcError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/** round(a / b) half-up, for a >= 0 and b > 0. */
function divRound(a: bigint, b: bigint): bigint {
  return (a * 2n + b) / (2n * b);
}

function toSafe(v: bigint, field: string): number {
  if (v > BigInt(MAX_INT)) throw new CalcError(field, 'Amount is too large');
  return Number(v);
}

export function calcLine(line: LineInput, taxType: TaxTypeValue, index = 0): LineResult {
  const gross = divRound(BigInt(line.quantityMilli) * BigInt(line.unitPriceMinor), 1000n);
  const discount = BigInt(line.discountMinor);
  if (discount > gross) {
    throw new CalcError(`items.${index}.discountMinor`, 'Discount cannot exceed the line amount');
  }
  const taxable = gross - discount;
  const bps = BigInt(taxType === 'NONE' ? 0 : line.taxRateBps);
  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  if (taxType === 'INTRA_STATE') {
    // CGST and SGST are each half the rate, rounded separately.
    cgst = divRound(taxable * bps, 20_000n);
    sgst = cgst;
  } else if (taxType === 'INTER_STATE') {
    igst = divRound(taxable * bps, 10_000n);
  }
  const tax = cgst + sgst + igst;
  const field = `items.${index}`;
  return {
    grossMinor: toSafe(gross, field),
    discountMinor: toSafe(discount, field),
    taxableAmountMinor: toSafe(taxable, field),
    cgstMinor: toSafe(cgst, field),
    sgstMinor: toSafe(sgst, field),
    igstMinor: toSafe(igst, field),
    taxAmountMinor: toSafe(tax, field),
    lineTotalMinor: toSafe(taxable + tax, field),
  };
}

export function calcInvoice(lines: LineInput[], taxType: TaxTypeValue) {
  const results = lines.map((l, i) => calcLine(l, taxType, i));
  const sum = (k: keyof LineResult) => results.reduce((s, r) => s + BigInt(r[k]), 0n);
  const totals: Totals = {
    subtotalMinor: toSafe(sum('grossMinor'), 'items'),
    discountMinor: toSafe(sum('discountMinor'), 'items'),
    taxableMinor: toSafe(sum('taxableAmountMinor'), 'items'),
    cgstMinor: toSafe(sum('cgstMinor'), 'items'),
    sgstMinor: toSafe(sum('sgstMinor'), 'items'),
    igstMinor: toSafe(sum('igstMinor'), 'items'),
    taxTotalMinor: toSafe(sum('taxAmountMinor'), 'items'),
    grandTotalMinor: toSafe(sum('lineTotalMinor'), 'items'),
  };
  return { lines: results, totals };
}

/** Indian financial year (April-March) of a date, e.g. 2026-10-28 -> "26-27". */
export function financialYear(date: Date): string {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? y : y - 1;
  const two = (n: number) => String(n % 100).padStart(2, '0');
  return `${two(start)}-${two(start + 1)}`;
}

/** e.g. ("INV", "26-27", 7) -> "INV/26-27/0007". At most 16 characters (GST rule). */
export function formatInvoiceNumber(prefix: string, fy: string, n: number): string {
  const number = `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
  if (number.length > 16) throw new Error('Invoice number longer than 16 characters');
  return number;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n]!;
  const rest = n % 10;
  return TENS[Math.floor(n / 10)]! + (rest ? ` ${ONES[rest]}` : '');
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** Whole number in Indian words (crore, lakh, thousand). */
export function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** 1265050 paise -> "Rupees Twelve Thousand Six Hundred Fifty and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  return `Rupees ${indianWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
}
