import { KANA, toKatakana } from '../kana'
import type { RawPack } from '../types'

/**
 * Japanese, as three decks: each kana syllabary, then the beginner kanji.
 *
 * Frequency-ordered vocabulary suits a language whose commonest words can be
 * glossed. Japanese opens with particles (の, に, は), which are grammar and
 * have no meaning to pick from four, and its words cannot be read until the
 * scripts can. So the scripts come first, each a deck of its own.
 */

export const HIRAGANA: RawPack = {
  code: 'ja-hira',
  name: 'ひらがな',
  englishName: 'Hiragana',
  kind: 'kana',
  words: KANA.map(([kana, romaji, group]) => [kana, romaji, group]),
}

export const KATAKANA: RawPack = {
  code: 'ja-kata',
  name: 'カタカナ',
  englishName: 'Katakana',
  kind: 'kana',
  words: KANA.map(([kana, romaji, group]) => [toKatakana(kana), romaji, group]),
}

/**
 * The JLPT N5 kanji, grouped by theme rather than ranked by frequency: numbers,
 * then the days of the week, and so on. Themes are the `pos`, so the wrong
 * answers on offer come from the same theme and the right one has to be known.
 *
 * The fourth column is the readings, space separated: kun'yomi in hiragana,
 * on'yomi in katakana, with okurigana left off (行 is い, not いく).
 */
export const KANJI: RawPack = {
  code: 'ja-kanji',
  name: '漢字',
  englishName: 'Kanji (N5)',
  kind: 'kanji',
  words: [
    ['一', 'one', 'number', 'ひと イチ'],
    ['二', 'two', 'number', 'ふた ニ'],
    ['三', 'three', 'number', 'み サン'],
    ['四', 'four', 'number', 'よ よん シ'],
    ['五', 'five', 'number', 'いつ ゴ'],
    ['六', 'six', 'number', 'む ロク'],
    ['七', 'seven', 'number', 'なな シチ'],
    ['八', 'eight', 'number', 'や ハチ'],
    ['九', 'nine', 'number', 'ここの キュウ ク'],
    ['十', 'ten', 'number', 'とお ジュウ'],
    ['百', 'hundred', 'number', 'ヒャク'],
    ['千', 'thousand', 'number', 'ち セン'],
    ['万', 'ten thousand', 'number', 'マン バン'],
    ['円', 'yen, circle', 'number', 'まる エン'],
    ['日', 'day, sun', 'nature', 'ひ か ニチ ジツ'],
    ['月', 'month, moon', 'nature', 'つき ゲツ ガツ'],
    ['火', 'fire', 'nature', 'ひ カ'],
    ['水', 'water', 'nature', 'みず スイ'],
    ['木', 'tree', 'nature', 'き モク ボク'],
    ['金', 'gold, money', 'nature', 'かね キン'],
    ['土', 'earth, soil', 'nature', 'つち ド ト'],
    ['山', 'mountain', 'nature', 'やま サン'],
    ['川', 'river', 'nature', 'かわ セン'],
    ['雨', 'rain', 'nature', 'あめ あま ウ'],
    ['天', 'heavens', 'nature', 'あま テン'],
    ['気', 'spirit, energy', 'nature', 'キ ケ'],
    ['年', 'year', 'time', 'とし ネン'],
    ['時', 'time, hour', 'time', 'とき ジ'],
    ['午', 'noon', 'time', 'ゴ'],
    ['半', 'half', 'time', 'ハン'],
    ['今', 'now', 'time', 'いま コン'],
    ['毎', 'every', 'time', 'マイ'],
    ['前', 'in front, before', 'time', 'まえ ゼン'],
    ['後', 'after, behind', 'time', 'あと うし ゴ コウ'],
    ['間', 'interval, between', 'time', 'あいだ ま カン ケン'],
    ['先', 'previous, ahead', 'time', 'さき セン'],
    ['人', 'person', 'people', 'ひと ジン ニン'],
    ['男', 'man', 'people', 'おとこ ダン ナン'],
    ['女', 'woman', 'people', 'おんな ジョ ニョ'],
    ['子', 'child', 'people', 'こ シ ス'],
    ['父', 'father', 'people', 'ちち フ'],
    ['母', 'mother', 'people', 'はは ボ'],
    ['友', 'friend', 'people', 'とも ユウ'],
    ['生', 'life, birth', 'people', 'い う なま セイ ショウ'],
    ['名', 'name', 'people', 'な メイ ミョウ'],
    ['上', 'up, above', 'direction', 'うえ うわ かみ あ ジョウ'],
    ['下', 'down, below', 'direction', 'した しも さ くだ カ ゲ'],
    ['中', 'middle, inside', 'direction', 'なか チュウ'],
    ['外', 'outside', 'direction', 'そと ほか ガイ ゲ'],
    ['右', 'right', 'direction', 'みぎ ウ ユウ'],
    ['左', 'left', 'direction', 'ひだり サ'],
    ['東', 'east', 'direction', 'ひがし トウ'],
    ['西', 'west', 'direction', 'にし セイ サイ'],
    ['南', 'south', 'direction', 'みなみ ナン'],
    ['北', 'north', 'direction', 'きた ホク'],
    ['大', 'big', 'quality', 'おお ダイ タイ'],
    ['小', 'small', 'quality', 'ちい こ お ショウ'],
    ['長', 'long, leader', 'quality', 'なが チョウ'],
    ['高', 'tall, expensive', 'quality', 'たか コウ'],
    ['白', 'white', 'quality', 'しろ ハク'],
    ['行', 'go', 'action', 'い ゆ コウ ギョウ'],
    ['来', 'come', 'action', 'く き こ ライ'],
    ['出', 'exit, leave', 'action', 'で だ シュツ'],
    ['入', 'enter', 'action', 'い はい ニュウ'],
    ['見', 'see', 'action', 'み ケン'],
    ['聞', 'hear, listen', 'action', 'き ブン モン'],
    ['話', 'talk', 'action', 'はな はなし ワ'],
    ['読', 'read', 'action', 'よ ドク'],
    ['書', 'write', 'action', 'か ショ'],
    ['食', 'eat', 'action', 'た く ショク'],
    ['休', 'rest', 'action', 'やす キュウ'],
    ['国', 'country', 'everyday', 'くに コク'],
    ['学', 'study, learning', 'everyday', 'まな ガク'],
    ['校', 'school', 'everyday', 'コウ'],
    ['本', 'book, origin', 'everyday', 'もと ホン'],
    ['語', 'language, word', 'everyday', 'かた ゴ'],
    ['電', 'electricity', 'everyday', 'デン'],
    ['車', 'car, vehicle', 'everyday', 'くるま シャ'],
    ['何', 'what', 'everyday', 'なに なん カ'],
  ],
}
