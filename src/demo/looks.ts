// The demo's pretend "create a new version": no AI, no service. A few colour looks (bluer, warmer,
// darker, softer…) applied to the picture's own pixels, in the browser. The screens say plainly
// that these results are examples. Pure functions (no DOM) so they can be tested.

export interface Look { label: string; hue: number; sat: number; bright: number; contrast: number; warm: number }
export interface Option { look: Look; amount: number; label: string }

export const LOOKS: Record<string, Look> = {
  blue:   { label: "כחולה יותר",  hue: 15,  sat: 1.1,  bright: 1.0,  contrast: 1.0,  warm: -1.0 },
  warm:   { label: "חמה וזהובה",  hue: 0,   sat: 1.25, bright: 1.05, contrast: 1.0,  warm: 0.4 },
  night:  { label: "ערב וכהה",    hue: 0,   sat: 0.9,  bright: 0.55, contrast: 1.1,  warm: -0.8 },
  bright: { label: "בהירה יותר",  hue: 0,   sat: 1.1,  bright: 1.25, contrast: 0.95, warm: 0.05 },
  green:  { label: "ירוקה יותר",  hue: 70,  sat: 1.2,  bright: 1.0,  contrast: 1.0,  warm: 0 },
  rose:   { label: "ורדרדה",      hue: 320, sat: 1.15, bright: 1.05, contrast: 1.0,  warm: 0.1 },
  soft:   { label: "רכה ופסטל",   hue: 0,   sat: 0.65, bright: 1.15, contrast: 0.85, warm: 0.05 },
  vivid:  { label: "חיה וצבעונית", hue: 0,  sat: 1.6,  bright: 1.0,  contrast: 1.15, warm: 0 },
  mono:   { label: "בשחור-לבן",   hue: 0,   sat: 0,    bright: 1.0,  contrast: 1.1,  warm: 0 },
};

// Whole words only ("צבעים" must not count as "ים"). One leading prefix letter is allowed (הים, בשחור).
const WORDS: Record<string, [string[], string]> = {
  blue: [["כחול", "כחולה", "כחולים", "תכלת", "ים", "שמיים", "שמי", "קר", "קרה", "קרירה"], "night"],
  warm: [["חם", "חמה", "חמים", "כתום", "כתומה", "שקיעה", "זהב", "זהוב", "זהובה", "צהוב", "צהובה", "שמש", "שמשי"], "vivid"],
  night: [["לילה", "כהה", "כהים", "ערב", "חשוך", "חשוכה"], "blue"],
  bright: [["בהיר", "בהירה", "בהירים", "יום", "אור", "בוהק", "בוהקת"], "soft"],
  green: [["ירוק", "ירוקה", "ירוקים", "טבע", "עלים", "דשא"], "vivid"],
  rose: [["אדום", "אדומה", "ורוד", "ורודה", "פרח", "פרחים", "ורד", "ורדים"], "warm"],
  soft: [["רך", "רכה", "רכים", "רכות", "עדין", "עדינה", "פסטל", "רגוע", "רגועה"], "bright"],
  vivid: [["חי", "חיה", "חיים", "עז", "עזה", "צבעוני", "צבעונית", "חזק", "חזקה"], "warm"],
  mono: [["שחור", "לבן", "אפור", "ישן", "ישנה"], "soft"],
};

function lookOf(word: string): string | null {
  const forms = [word];
  if (word.length > 2 && /^[והבלמכש]/.test(word)) forms.push(word.slice(1));
  for (const [key, [list]] of Object.entries(WORDS)) if (forms.some((f) => list.includes(f))) return key;
  return null;
}

/** Three options for what was asked: the look, a gentler version of it, and a neighbouring one. */
export function pickLooks(prompt: string): Option[] {
  const main = prompt.split(/[^א-ת]+/).map(lookOf).find((k): k is string => !!k);
  if (!main) {
    return (["warm", "soft", "vivid"] as const).map((k) => ({ look: LOOKS[k], amount: 1, label: LOOKS[k].label }));
  }
  const near = WORDS[main][1];
  return [
    { look: LOOKS[main], amount: 1, label: LOOKS[main].label },
    { look: LOOKS[main], amount: 0.5, label: `${LOOKS[main].label} (עדין)` },
    { look: LOOKS[near], amount: 0.85, label: LOOKS[near].label },
  ];
}

/** The 3×3 colour matrix of a look (hue rotation, then saturation), as in CSS filters. */
export function matrixOf(l: Look): number[] {
  const rad = (l.hue * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const H = [
    0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.928 * s,
    0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.14 * s, 0.072 - 0.072 * c - 0.283 * s,
    0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s,
  ];
  const t = l.sat;
  const S = [
    0.213 + 0.787 * t, 0.715 - 0.715 * t, 0.072 - 0.072 * t,
    0.213 - 0.213 * t, 0.715 + 0.285 * t, 0.072 - 0.072 * t,
    0.213 - 0.213 * t, 0.715 - 0.715 * t, 0.072 + 0.928 * t,
  ];
  const M = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) M[r * 3 + k] += S[r * 3 + j] * H[j * 3 + k];
  return M;
}

/** Applies the look to RGBA pixels in place. `amount` 0 = the original, 1 = the full look. */
export function applyLook(px: Uint8ClampedArray, look: Look, amount = 1): void {
  const M = matrixOf(look);
  const wr = 1 + 0.25 * look.warm, wb = 1 - 0.25 * look.warm;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    let R = (M[0] * r + M[1] * g + M[2] * b) * wr;
    let G = M[3] * r + M[4] * g + M[5] * b;
    let B = (M[6] * r + M[7] * g + M[8] * b) * wb;
    R = ((R * look.bright) - 128) * look.contrast + 128;
    G = ((G * look.bright) - 128) * look.contrast + 128;
    B = ((B * look.bright) - 128) * look.contrast + 128;
    px[i] = r + (R - r) * amount;
    px[i + 1] = g + (G - g) * amount;
    px[i + 2] = b + (B - b) * amount;
  }
}
