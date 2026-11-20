/** OpenType layout adapter: glyph selection, optional features and pair kerning.
 * Feature lookups run in lookup-list order, as HarfBuzz applies them, so a
 * stylistic set can change a glyph before the ligature lookups see it.
 * Kerning is read from the raw GPOS table because OpenType.js does not parse
 * extension lookups.
 */
const DEFAULT_FEATURES = ['liga', 'rlig'];

/** Default language system of the Latin script, else DFLT, else the first script. */
function languageSystem(table) {
  const script = ['latn', 'DFLT'].map(tag => table.scripts.find(s => s.tag === tag)).find(Boolean) ?? table.scripts[0];
  return script?.script.defaultLangSys ?? script?.script.langSysRecords[0]?.langSys;
}
function featureTags(table) {
  if (!table) return [];
  const tags = languageSystem(table)?.featureIndexes.map(index => table.features[index]?.tag);
  return [...new Set(tags)].filter(Boolean).sort();
}
function featureLookups(table, tags) {
  const lookups = new Set();
  for (const index of (table && languageSystem(table)?.featureIndexes) ?? []) {
    const feature = table.features[index];
    if (feature && tags.includes(feature.tag)) feature.feature.lookupListIndexes.forEach(lookup => lookups.add(lookup));
  }
  return [...lookups].sort((a, b) => a - b);
}

function coverageIndex(coverage, glyph) {
  if (coverage.format === 1) return coverage.glyphs.indexOf(glyph);
  for (const range of coverage.ranges) if (glyph >= range.start && glyph <= range.end) return range.index + glyph - range.start;
  return -1;
}
/** Apply one GSUB lookup. Single, multiple, alternate (first alternate) and
 * ligature substitutions are supported; contextual lookups leave glyphs unchanged.
 */
function substitute(lookup, glyphs) {
  const output = [];
  for (let i = 0; i < glyphs.length; i++) {
    let replacement;
    for (const entry of lookup.subtables) {
      const type = entry.extension ? entry.lookupType : lookup.lookupType, subtable = entry.extension ?? entry;
      const index = subtable.coverage ? coverageIndex(subtable.coverage, glyphs[i]) : -1;
      if (index < 0) continue;
      if (type === 1) replacement = [subtable.substFormat === 1 ? (glyphs[i] + subtable.deltaGlyphId) & 0xffff : subtable.substitute[index]];
      else if (type === 2) replacement = subtable.sequences[index];
      else if (type === 3) replacement = subtable.alternateSets[index].slice(0, 1);
      else if (type === 4) {
        const ligature = subtable.ligatureSets[index].find(({ components }) => components.every((glyph, j) => glyphs[i + 1 + j] === glyph));
        if (ligature) { replacement = [ligature.ligGlyph]; i += ligature.components.length; }
      }
      if (replacement) break;
    }
    output.push(...(replacement ?? [glyphs[i]]));
  }
  return output;
}

function coverageMap(view, offset) {
  const map = new Map(), count = view.getUint16(offset + 2);
  if (view.getUint16(offset) === 1) for (let i = 0; i < count; i++) map.set(view.getUint16(offset + 4 + i * 2), i);
  else for (let i = 0; i < count; i++) {
    const record = offset + 4 + i * 6, start = view.getUint16(record), index = view.getUint16(record + 4);
    for (let glyph = start; glyph <= view.getUint16(record + 2); glyph++) map.set(glyph, index + glyph - start);
  }
  return map;
}
function classMap(view, offset) {
  const map = new Map();
  if (view.getUint16(offset) === 1) {
    const start = view.getUint16(offset + 2), count = view.getUint16(offset + 4);
    for (let i = 0; i < count; i++) map.set(start + i, view.getUint16(offset + 6 + i * 2));
  } else for (let i = 0, count = view.getUint16(offset + 2); i < count; i++) {
    const record = offset + 4 + i * 6, value = view.getUint16(record + 4);
    for (let glyph = view.getUint16(record); glyph <= view.getUint16(record + 2); glyph++) map.set(glyph, value);
  }
  return map;
}
const bitCount = value => { let count = 0; for (; value; value >>= 1) count += value & 1; return count; };
/** Pair adjustment subtable as (left, right) => first-glyph xAdvance, or
 * undefined when the subtable does not apply and the next one should be tried.
 */
function pairSubtable(view, offset) {
  const format = view.getUint16(offset), coverage = coverageMap(view, offset + view.getUint16(offset + 2));
  const format1 = view.getUint16(offset + 4), format2 = view.getUint16(offset + 6);
  const advance = format1 & 4 ? bitCount(format1 & 3) * 2 : -1, size = (bitCount(format1) + bitCount(format2)) * 2;
  if (format === 1) {
    const pairs = new Map();
    for (const [left, index] of coverage) {
      const set = offset + view.getUint16(offset + 10 + index * 2);
      for (let i = 0, count = view.getUint16(set); i < count; i++) {
        const record = set + 2 + i * (size + 2), key = left * 65536 + view.getUint16(record);
        if (!pairs.has(key)) pairs.set(key, advance < 0 ? 0 : view.getInt16(record + 2 + advance));
      }
    }
    return (left, right) => pairs.get(left * 65536 + right);
  }
  if (format !== 2) return () => undefined;
  const class1 = classMap(view, offset + view.getUint16(offset + 8)), class2 = classMap(view, offset + view.getUint16(offset + 10));
  const count1 = view.getUint16(offset + 12), count2 = view.getUint16(offset + 14);
  return (left, right) => {
    // Like HarfBuzz, right-hand class 0 falls through to the next subtable.
    const first = class1.get(left) ?? 0, second = class2.get(right) ?? 0;
    if (!coverage.has(left) || !second || first >= count1 || second >= count2) return undefined;
    return advance < 0 ? 0 : view.getInt16(offset + 16 + (first * count2 + second) * size + advance);
  };
}
/** Sum of every kern lookup's first applicable pair adjustment, in font units. */
function pairKerning(bytes, lookupIndexes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), list = view.getUint16(8), lookups = [];
  for (const index of lookupIndexes) {
    const lookup = list + view.getUint16(list + 2 + index * 2), type = view.getUint16(lookup), subtables = [];
    for (let i = 0, count = view.getUint16(lookup + 4); i < count; i++) {
      let offset = lookup + view.getUint16(lookup + 6 + i * 2), subtableType = type;
      if (type === 9) { subtableType = view.getUint16(offset + 2); offset += view.getUint32(offset + 4); }
      if (subtableType === 2) subtables.push(pairSubtable(view, offset));
    }
    if (subtables.length) lookups.push(subtables);
  }
  return (left, right) => {
    let total = 0;
    for (const subtables of lookups) for (const pair of subtables) {
      const value = pair(left, right);
      if (value !== undefined) { total += value; break; }
    }
    return total;
  };
}

/** Wrap a parsed OpenType.js font and its raw GPOS bytes (if any) for the renderer. */
export function createLayout(font, gpos) {
  const kernLookups = gpos ? featureLookups(font.tables.gpos, ['kern']) : [];
  const kerning = kernLookups.length ? pairKerning(gpos, kernLookups) : (left, right) => font.kerningPairs?.[`${left},${right}`] || 0;
  return {
    unitsPerEm: font.unitsPerEm,
    /** GSUB feature tags the font offers, e.g. to list its stylistic sets. */
    features: featureTags(font.tables.gsub),
    stringToGlyphs(text, features = []) {
      let glyphs = font.stringToGlyphIndexes(text, { features: {} });
      for (const index of featureLookups(font.tables.gsub, [...DEFAULT_FEATURES, ...features])) glyphs = substitute(font.tables.gsub.lookups[index], glyphs);
      return glyphs.map(index => font.glyphs.get(index) || font.glyphs.get(0));
    },
    getKerningValue: (left, right) => kerning(left.index, right.index),
  };
}
