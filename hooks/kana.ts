/**
 * Kana: the two Japanese syllabaries, and reading them back from romaji.
 *
 * One table serves three purposes. It is the hiragana deck, in the order it is
 * taught; shifted by a fixed distance in Unicode it is the katakana deck; and
 * it is what turns a typed reading into kana so it can be compared, which is
 * how a kanji or kana card can be answered without a Japanese keyboard.
 */

/** `[hiragana, romaji, group]`, in teaching order: the plain set, then the voiced, then the combinations. */
export const KANA: ReadonlyArray<readonly [string, string, string]> = [
  ['あ', 'a', 'vowel'], ['い', 'i', 'vowel'], ['う', 'u', 'vowel'], ['え', 'e', 'vowel'], ['お', 'o', 'vowel'],
  ['か', 'ka', 'k-row'], ['き', 'ki', 'k-row'], ['く', 'ku', 'k-row'], ['け', 'ke', 'k-row'], ['こ', 'ko', 'k-row'],
  ['さ', 'sa', 's-row'], ['し', 'shi', 's-row'], ['す', 'su', 's-row'], ['せ', 'se', 's-row'], ['そ', 'so', 's-row'],
  ['た', 'ta', 't-row'], ['ち', 'chi', 't-row'], ['つ', 'tsu', 't-row'], ['て', 'te', 't-row'], ['と', 'to', 't-row'],
  ['な', 'na', 'n-row'], ['に', 'ni', 'n-row'], ['ぬ', 'nu', 'n-row'], ['ね', 'ne', 'n-row'], ['の', 'no', 'n-row'],
  ['は', 'ha', 'h-row'], ['ひ', 'hi', 'h-row'], ['ふ', 'fu', 'h-row'], ['へ', 'he', 'h-row'], ['ほ', 'ho', 'h-row'],
  ['ま', 'ma', 'm-row'], ['み', 'mi', 'm-row'], ['む', 'mu', 'm-row'], ['め', 'me', 'm-row'], ['も', 'mo', 'm-row'],
  ['や', 'ya', 'y-row'], ['ゆ', 'yu', 'y-row'], ['よ', 'yo', 'y-row'],
  ['ら', 'ra', 'r-row'], ['り', 'ri', 'r-row'], ['る', 'ru', 'r-row'], ['れ', 're', 'r-row'], ['ろ', 'ro', 'r-row'],
  ['わ', 'wa', 'w-row'], ['を', 'wo', 'w-row'],
  ['ん', 'n', 'syllabic n'],
  ['が', 'ga', 'g-row'], ['ぎ', 'gi', 'g-row'], ['ぐ', 'gu', 'g-row'], ['げ', 'ge', 'g-row'], ['ご', 'go', 'g-row'],
  ['ざ', 'za', 'z-row'], ['じ', 'ji', 'z-row'], ['ず', 'zu', 'z-row'], ['ぜ', 'ze', 'z-row'], ['ぞ', 'zo', 'z-row'],
  // ぢ and づ sound like じ and ず. They are romanised di and du, as an IME
  // types them, because a reverse card asking "which is ji?" with two right
  // answers on offer cannot be answered.
  ['だ', 'da', 'd-row'], ['ぢ', 'di', 'd-row'], ['づ', 'du', 'd-row'], ['で', 'de', 'd-row'], ['ど', 'do', 'd-row'],
  ['ば', 'ba', 'b-row'], ['び', 'bi', 'b-row'], ['ぶ', 'bu', 'b-row'], ['べ', 'be', 'b-row'], ['ぼ', 'bo', 'b-row'],
  ['ぱ', 'pa', 'p-row'], ['ぴ', 'pi', 'p-row'], ['ぷ', 'pu', 'p-row'], ['ぺ', 'pe', 'p-row'], ['ぽ', 'po', 'p-row'],
  ['きゃ', 'kya', 'ky-row'], ['きゅ', 'kyu', 'ky-row'], ['きょ', 'kyo', 'ky-row'],
  ['しゃ', 'sha', 'sh-row'], ['しゅ', 'shu', 'sh-row'], ['しょ', 'sho', 'sh-row'],
  ['ちゃ', 'cha', 'ch-row'], ['ちゅ', 'chu', 'ch-row'], ['ちょ', 'cho', 'ch-row'],
  ['にゃ', 'nya', 'ny-row'], ['にゅ', 'nyu', 'ny-row'], ['にょ', 'nyo', 'ny-row'],
  ['ひゃ', 'hya', 'hy-row'], ['ひゅ', 'hyu', 'hy-row'], ['ひょ', 'hyo', 'hy-row'],
  ['みゃ', 'mya', 'my-row'], ['みゅ', 'myu', 'my-row'], ['みょ', 'myo', 'my-row'],
  ['りゃ', 'rya', 'ry-row'], ['りゅ', 'ryu', 'ry-row'], ['りょ', 'ryo', 'ry-row'],
  ['ぎゃ', 'gya', 'gy-row'], ['ぎゅ', 'gyu', 'gy-row'], ['ぎょ', 'gyo', 'gy-row'],
  ['じゃ', 'ja', 'j-row'], ['じゅ', 'ju', 'j-row'], ['じょ', 'jo', 'j-row'],
  ['びゃ', 'bya', 'by-row'], ['びゅ', 'byu', 'by-row'], ['びょ', 'byo', 'by-row'],
  ['ぴゃ', 'pya', 'py-row'], ['ぴゅ', 'pyu', 'py-row'], ['ぴょ', 'pyo', 'py-row'],
]

/** Hiragana and katakana sit 0x60 apart, character for character. */
const SHIFT = 0x60

export function toKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + SHIFT))
}

export function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - SHIFT))
}

const KANA_ONLY = /^[\p{scx=Hiragana}\p{scx=Katakana}]+$/u

/** Is this written wholly in kana, so it can be read back from romaji? */
export function isKana(text: string): boolean {
  return KANA_ONLY.test(text)
}

const TO_ROMAJI = new Map(KANA.map(([kana, romaji]) => [kana, romaji]))

/** How these are said, as opposed to how the deck spells them. */
const SPOKEN: Record<string, string> = { ぢ: 'ji', づ: 'zu', を: 'o' }

/**
 * Kana as romaji, or null for a character the table does not hold.
 *
 * `spoken` reads ぢ, づ and を as they sound, which is what a typed answer is
 * compared on; without it they keep the spellings the deck teaches.
 */
export function kanaToRomaji(text: string, { spoken = false } = {}): string | null {
  const hiragana = toHiragana(text)
  let out = ''
  let double = false

  for (let i = 0; i < hiragana.length; ) {
    const char = hiragana[i] as string

    if (char === 'っ') {
      double = true
      i += 1
      continue
    }

    if (char === 'ー') {
      // A katakana long mark repeats the vowel before it.
      out += out.at(-1) ?? ''
      i += 1
      continue
    }

    const pair = hiragana.slice(i, i + 2)
    const unit = TO_ROMAJI.has(pair) ? pair : char
    const romaji = (spoken && SPOKEN[unit]) || TO_ROMAJI.get(unit)

    if (romaji === undefined) return null

    // っ doubles the consonant after it, and Hepburn writes っち as "tchi".
    out += double ? (romaji.startsWith('ch') ? 't' : romaji[0]) + romaji : romaji
    double = false
    i += unit.length
  }

  return out
}

/** Romaji to hiragana: the deck's spellings, plus the other systems people type. */
const FROM_ROMAJI = new Map<string, string>([
  ...KANA.map(([kana, romaji]) => [romaji, kana] as [string, string]),
  ['si', 'し'], ['ti', 'ち'], ['tu', 'つ'], ['hu', 'ふ'], ['zi', 'じ'],
  ['sya', 'しゃ'], ['syu', 'しゅ'], ['syo', 'しょ'],
  ['tya', 'ちゃ'], ['tyu', 'ちゅ'], ['tyo', 'ちょ'],
  ['cya', 'ちゃ'], ['cyu', 'ちゅ'], ['cyo', 'ちょ'],
  ['zya', 'じゃ'], ['zyu', 'じゅ'], ['zyo', 'じょ'],
  ['jya', 'じゃ'], ['jyu', 'じゅ'], ['jyo', 'じょ'],
])

const VOWELS = new Set(['a', 'i', 'u', 'e', 'o'])

/** Romaji as hiragana, or null when some of it is not romaji at all. */
export function romajiToKana(text: string): string | null {
  const romaji = text.toLowerCase().replace(/[\s-]/g, '')
  let out = ''

  for (let i = 0; i < romaji.length; ) {
    const char = romaji[i] as string
    const next = romaji[i + 1]

    if (char === 'n') {
      if (next === "'") {
        out += 'ん'
        i += 2
        continue
      }

      // An n not starting a syllable is ん. "nn" before a consonant or at the
      // end is one ん typed twice; before a vowel the second n starts "na".
      if (next === undefined || (!VOWELS.has(next) && next !== 'y')) {
        const after = romaji[i + 2]
        const twice = next === 'n' && (after === undefined || (!VOWELS.has(after) && after !== 'y'))

        out += 'ん'
        i += twice ? 2 : 1
        continue
      }
    }

    // A doubled consonant is a small っ, and so is the t of "tch".
    if (next !== undefined && !VOWELS.has(char) && (char === next || (char === 't' && next === 'c'))) {
      out += 'っ'
      i += 1
      continue
    }

    const unit = [3, 2, 1].map((n) => romaji.slice(i, i + n)).find((piece) => FROM_ROMAJI.has(piece))

    if (unit === undefined) return null

    out += FROM_ROMAJI.get(unit)
    i += unit.length
  }

  return out
}

/**
 * How a reading sounds, as one comparable string.
 *
 * Romaji goes through kana first, so "si" and "shi" arrive at the same place;
 * kana of either script goes through romaji, so ちゅう and チュウ do too. Long
 * vowels are folded, because "kyu" for キュウ is how most people type it.
 */
function sound(text: string): string | null {
  const trimmed = text.trim()
  const kana = /[a-z]/i.test(trimmed) ? romajiToKana(trimmed) : trimmed

  if (!kana || !isKana(kana)) return null

  const romaji = kanaToRomaji(kana, { spoken: true })

  return romaji === null ? null : romaji.replace(/ou|oo/g, 'o').replace(/uu/g, 'u')
}

/** Did someone type this kana reading, in kana or romaji? */
export function sameReading(reading: string, typed: string): boolean {
  if (!isKana(reading)) return false

  const expected = sound(reading)

  return expected !== null && expected === sound(typed)
}
