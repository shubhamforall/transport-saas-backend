import { describe, expect, it } from 'vitest';
import {
  amountInWords,
  calcInvoice,
  calcLine,
  financialYear,
  formatInvoiceNumber,
} from '../src/modules/invoices/calc.js';

const line = (o: Partial<Parameters<typeof calcLine>[0]> = {}) => ({
  quantityMilli: 1000,
  unitPriceMinor: 1_200_000,
  discountMinor: 0,
  taxRateBps: 1800,
  ...o,
});

describe('invoice calculations', () => {
  it('no tax: total is quantity x price minus discount', () => {
    const { totals } = calcInvoice(
      [line(), line({ unitPriceMinor: 50_000, discountMinor: 10_000 })],
      'NONE',
    );
    expect(totals).toEqual({
      subtotalMinor: 1_250_000,
      discountMinor: 10_000,
      taxableMinor: 1_240_000,
      cgstMinor: 0,
      sgstMinor: 0,
      igstMinor: 0,
      taxTotalMinor: 0,
      grandTotalMinor: 1_240_000,
    });
  });

  it('intra-state splits tax into equal CGST and SGST', () => {
    const r = calcLine(line(), 'INTRA_STATE');
    expect(r).toMatchObject({
      cgstMinor: 108_000,
      sgstMinor: 108_000,
      igstMinor: 0,
      lineTotalMinor: 1_416_000,
    });
  });

  it('inter-state uses IGST', () => {
    const r = calcLine(line({ taxRateBps: 500 }), 'INTER_STATE');
    expect(r).toMatchObject({ igstMinor: 60_000, taxAmountMinor: 60_000 });
  });

  it('rounds half-up to the paisa and handles fractional quantities', () => {
    // 2.5 x ₹33.33 = ₹83.325 -> ₹83.33
    expect(
      calcLine(line({ quantityMilli: 2500, unitPriceMinor: 3333, taxRateBps: 0 }), 'NONE')
        .grossMinor,
    ).toBe(8333);
    // 5% of ₹0.10 = 0.5 paise -> 1 paisa (IGST); 2.5% each -> 0.25 -> 0 paise CGST/SGST
    expect(calcLine(line({ unitPriceMinor: 10, taxRateBps: 500 }), 'INTER_STATE').igstMinor).toBe(
      1,
    );
    expect(calcLine(line({ unitPriceMinor: 10, taxRateBps: 500 }), 'INTRA_STATE').cgstMinor).toBe(
      0,
    );
  });

  it('never loses precision on big numbers and rejects totals that overflow', () => {
    expect(
      calcLine(line({ quantityMilli: 1_000_000, unitPriceMinor: 1000, taxRateBps: 0 }), 'NONE')
        .grossMinor,
    ).toBe(1_000_000);
    expect(() =>
      calcLine(line({ quantityMilli: 1_000_000_000, unitPriceMinor: 1_000_000_000 }), 'NONE'),
    ).toThrow(/too large/);
  });

  it('rejects a discount larger than the line', () => {
    expect(() => calcLine(line({ discountMinor: 2_000_000 }), 'NONE')).toThrow(/Discount/);
  });
});

describe('invoice numbering', () => {
  it('uses the Indian financial year (April to March)', () => {
    expect(financialYear(new Date('2026-04-01'))).toBe('26-27');
    expect(financialYear(new Date('2027-03-31'))).toBe('26-27');
    expect(financialYear(new Date('2026-03-31'))).toBe('25-26');
  });

  it('formats numbers within the 16-character GST limit', () => {
    expect(formatInvoiceNumber('INV', '26-27', 7)).toBe('INV/26-27/0007');
    expect(formatInvoiceNumber('PTC', '26-27', 12345)).toBe('PTC/26-27/12345');
    expect(() => formatInvoiceNumber('PTC01', '26-27', 12345)).toThrow(/16/);
  });
});

describe('amount in words', () => {
  it('uses lakh and crore', () => {
    expect(amountInWords(1_265_050)).toBe(
      'Rupees Twelve Thousand Six Hundred Fifty and Fifty Paise Only',
    );
    expect(amountInWords(24_850_000)).toBe(
      'Rupees Two Lakh Forty Eight Thousand Five Hundred Only',
    );
    expect(amountInWords(1_234_567_800)).toBe(
      'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only',
    );
    expect(amountInWords(0)).toBe('Rupees Zero Only');
  });
});
