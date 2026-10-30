// Identifier helpers: member IDs, NPIs, CPT codes and auth numbers as they appear after OCR or keying.

/** Characters OCR commonly confuses with digits. */
const OCR_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', S: '5', B: '8', Z: '2', G: '6' };

export function ocrDigits(s: string): string {
  return s
    .toUpperCase()
    .split('')
    .map((c) => OCR_DIGIT[c] ?? c)
    .join('');
}

/** Member IDs look like M + 8 digits. Repairs OCR letter/digit swaps in the digit part. */
export function normalizeMemberId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase().replace(/[\s\-_.]/g, '');
  if (!s) return undefined;
  const head = 'NWH'.includes(s[0]) ? 'M' : s[0]; // OCR reads of "M"
  const body = ocrDigits(s.slice(1)).replace(/[^0-9]/g, '');
  return head + body;
}

/** NPI check digit: Luhn over "80840" + first 9 digits. */
export function npiCheckDigit(first9: string): number {
  const digits = ('80840' + first9).split('').map(Number);
  let sum = 0;
  // Double every second digit from the right of the 14-digit string (the check digit position is to its right).
  for (let i = digits.length - 1, dbl = true; i >= 0; i--, dbl = !dbl) {
    let v = digits[i];
    if (dbl) {
      v *= 2;
      if (v > 9) v -= 9;
    }
    sum += v;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidNpi(npi: string | undefined): boolean {
  if (!npi || !/^\d{10}$/.test(npi)) return false;
  return npiCheckDigit(npi.slice(0, 9)) === Number(npi[9]);
}

export function normalizeNpi(raw: string | undefined): { npi?: string; valid: boolean } {
  if (!raw) return { valid: false };
  const n = ocrDigits(raw).replace(/[^0-9]/g, '');
  if (!n) return { valid: false };
  return { npi: n, valid: isValidNpi(n) };
}

/** CPT is 5 digits; HCPCS level II is a letter + 4 digits. */
export function normalizeCpt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase().replace(/[^A-Z0-9|]/g, '');
  if (s.length !== 5) return undefined;
  if (/[A-Z]/.test(s[0]) && !(s[0] in OCR_DIGIT)) {
    // HCPCS level II, e.g. E0601
    const rest = ocrDigits(s.slice(1));
    return /^\d{4}$/.test(rest) ? s[0] + rest : undefined;
  }
  const d = ocrDigits(s);
  return /^\d{5}$/.test(d) ? d : undefined;
}

export function normalizeAuth(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.toUpperCase().replace(/\s/g, '');
  const m = s.match(/^([A-Z])(\w{4})-?(\w+)$/);
  if (!m) return s || undefined;
  return `${m[1]}${ocrDigits(m[2])}-${ocrDigits(m[3])}`;
}

/** Damerau-Levenshtein distance (optimal string alignment), capped for speed. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}
