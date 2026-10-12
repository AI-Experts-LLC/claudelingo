/**
 * Kana, and reading it back from what someone typed.
 *
 * A reading card is answered on a keyboard that may not have Japanese on it,
 * so it has to take romaji in whichever system the person learned, and kana in
 * either script, and still refuse a near miss: が is not か, and みす is not みず.
 */
import { describe, expect, it } from 'vitest'

import { KANA, kanaToRomaji, romajiToKana, sameReading, toHiragana, toKatakana } from '../hooks/kana'

describe('the kana table', () => {
  it('reads every kana both ways', () => {
    for (const [kana, romaji] of KANA) {
      expect(kanaToRomaji(kana), kana).toBe(romaji)
      expect(romajiToKana(romaji), romaji).toBe(kana)
    }
  })

  it('spells every kana differently, so no reverse card has two right answers', () => {
    expect(new Set(KANA.map(([, romaji]) => romaji)).size).toBe(KANA.length)
  })

  it('moves between the scripts', () => {
    expect(toKatakana('きゃ')).toBe('キャ')
    expect(toHiragana('ラーメン')).toBe('らーめん')
  })
})

describe('reading romaji', () => {
  it('doubles a consonant with a small っ', () => {
    expect(romajiToKana('kitte')).toBe('きって')
    expect(romajiToKana('matcha')).toBe('まっちゃ')
    expect(kanaToRomaji('マッチャ')).toBe('matcha')
  })

  it('tells ん from the start of a syllable', () => {
    expect(romajiToKana('hon')).toBe('ほん')
    expect(romajiToKana('sanpo')).toBe('さんぽ')
    expect(romajiToKana('konna')).toBe('こんな')
    expect(romajiToKana("kon'ya")).toBe('こんや')
  })

  it('refuses what is not romaji', () => {
    expect(romajiToKana('xyz')).toBeNull()
  })
})

describe('checking a typed reading', () => {
  it.each([
    ['し', 'shi'],
    ['し', 'si'],
    ['ち', 'ti'],
    ['ぢ', 'ji'],
    ['ぢ', 'di'],
    ['を', 'o'],
    ['みず', 'mizu'],
    ['みず', 'みず'],
    ['スイ', 'sui'],
    ['スイ', 'すい'],
    ['キュウ', 'kyuu'],
    ['キュウ', 'kyu'],
    ['ジョウ', 'jo'],
  ])('takes %s typed as "%s"', (reading, typed) => {
    expect(sameReading(reading, typed)).toBe(true)
  })

  it.each([
    ['みず', 'misu'],
    ['が', 'ka'],
    ['か', 'ga'],
    ['みず', ''],
  ])('refuses %s typed as "%s"', (reading, typed) => {
    expect(sameReading(reading, typed)).toBe(false)
  })

  it('leaves answers that are not kana to the ordinary comparison', () => {
    expect(sameReading('casa', 'casa')).toBe(false)
  })
})
