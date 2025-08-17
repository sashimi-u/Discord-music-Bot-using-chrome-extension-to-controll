//node test_similarity.js "Seed song title" "Candidate song title" "AuthorName (optional)"

const utils = require('./lib/utils.js')();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// load removeKeywords.json (same logic as Autoplay)
let REMOVE_KEYWORDS = ['mv','music video','performance','performance video','字幕','subtitles','cover','official','live','lyrics','lyric','karaoke','instrumental'];
let SIMILARITY_THRESHOLD = 0.85;
let TITLE_MAX_LENGTH = 120;
let FORBIDDEN_WORDS = [];
try {
  const kwPath = path.join(__dirname, 'removeKeywords.json');
  if (fs.existsSync(kwPath)) {
    const raw = fs.readFileSync(kwPath, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (e) { parsed = JSON.parse(raw.replace(/\/\/.*$/gm, '')); }
    if (parsed && Array.isArray(parsed.removeKeywords)) REMOVE_KEYWORDS = parsed.removeKeywords.map(k => utils.normalizeText(String(k)));
    if (parsed && typeof parsed.similarityThreshold === 'number') {
      const v = parsed.similarityThreshold;
      if (v > 0 && v <= 1) SIMILARITY_THRESHOLD = v;
    }
    if (parsed && typeof parsed.titleMaxLength === 'number' && parsed.titleMaxLength > 0) TITLE_MAX_LENGTH = Math.floor(parsed.titleMaxLength);
    if (parsed && Array.isArray(parsed.forbiddenWords)) FORBIDDEN_WORDS = parsed.forbiddenWords.map(w => utils.normalizeText(String(w)).trim()).filter(Boolean);
  }
} catch (e) { /* ignore */ }

function escapeRegExp(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// remove anything after '#'
function stripAfterHashRaw(s) {
  if (!s) return '';
  return String(s).split('#')[0].trim();
}

// Unicode-aware stripAuthorAndKeywords (match Autoplay.js)
function stripAuthorAndKeywords(title, authorName) {
  let beforeHash = stripAfterHashRaw(title || '');
  let s = utils.normalizeText(beforeHash || '');
  if (!s) return s;
  const wordBoundaryPattern = '(?<![\\p{L}\\p{N}])';
  const wordBoundaryEnd = '(?![\\p{L}\\p{N}])';

  if (authorName) {
    const an = utils.normalizeText(authorName || '');
    if (an) {
      s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(an)}${wordBoundaryEnd}`, 'gu'), ' ');
      for (const tok of an.split(/\s+/).filter(Boolean)) {
        s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(tok)}${wordBoundaryEnd}`, 'gu'), ' ');
      }
    }
  }

  for (const kw of REMOVE_KEYWORDS) {
    if (!kw) continue;
    s = s.replace(new RegExp(`${wordBoundaryPattern}${escapeRegExp(kw)}${wordBoundaryEnd}`, 'gu'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

function containsForbiddenWord(title) {
  if (!title) return false;
  const tn = utils.normalizeText(stripAfterHashRaw(title || ''));
  if (!tn) return false;
  for (const fw of FORBIDDEN_WORDS) {
    if (!fw) continue;
    if (tn.includes(fw)) return true;
  }
  return false;
}

// token-overlap ratio (0..1)
function titleSimilarityRatio(a, b) {
  const na = utils.normalizeText(String(a || ''));
  const nb = utils.normalizeText(String(b || ''));
  if (!na || !nb) return 0;
  const ta = na.split(/\s+/).filter(Boolean);
  const tb = nb.split(/\s+/).filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  let inter = 0;
  for (const t of tb) if (setA.has(t)) inter++;
  return inter / Math.max(ta.length, tb.length);
}

function isTooSimilar(a, b, threshold = SIMILARITY_THRESHOLD) {
  try {
    if (typeof utils.titleTooSimilar === 'function') {
      if (utils.titleTooSimilar(a, b)) return true;
    }
  } catch (e) {}
  return titleSimilarityRatio(a, b) >= threshold;
}

function detectAuthorAppearsInTitle(seedTitle, authorName) {
  if (!authorName) return false;
  const seedNorm = utils.normalizeText(seedTitle || '');
  const authorNorm = utils.normalizeText(authorName || '');
  if (!seedNorm || !authorNorm) return false;
  if (seedNorm.includes(authorNorm)) return true;
  const authorTokens = authorNorm.split(/\s+/).filter(Boolean);
  const seedTokens = new Set(seedNorm.split(/\s+/).filter(Boolean));
  for (const t of authorTokens) if (t && seedTokens.has(t)) return true;
  return false;
}

async function interactivePrompt(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise(resolve => rl.question(promptText, a => { rl.close(); resolve(a); }));
  return ans;
}

async function main() {
  let seed = process.argv[2];
  let candidate = process.argv[3];
  let author = process.argv[4];

  if (!seed) seed = (await interactivePrompt('Enter seed (first) song title: ')).trim();
  if (!candidate) candidate = (await interactivePrompt('Enter candidate song title: ')).trim();
  if (!author) author = (await interactivePrompt('Enter channel/author name for seed (optional, leave blank to skip): ')).trim();
  if (author === '') author = null;

  console.log('\n--- Inputs ---');
  console.log('Seed title:', seed);
  console.log('Candidate title:', candidate);
  console.log('Provided author:', author || '(none)');
  console.log('Configured removeKeywords count:', REMOVE_KEYWORDS.length);
  console.log('Similarity threshold:', SIMILARITY_THRESHOLD);
  console.log('---------------\n');

  const normSeed = utils.normalizeText(seed);
  const normCand = utils.normalizeText(candidate);
  console.log('Normalized seed:', normSeed);
  console.log('Normalized candidate:', normCand);

  const directRatio = titleSimilarityRatio(normSeed, normCand);
  const directTooSimilar = isTooSimilar(normSeed, normCand);
  console.log(`\nDirect token-overlap ratio: ${directRatio.toFixed(3)} → isTooSimilar: ${directTooSimilar}`);

  const authorAppears = detectAuthorAppearsInTitle(seed, author);
  console.log('\nAuthor appears in seed title:', authorAppears);

  // strip with author (if author appears)
  if (authorAppears) {
    const strippedSeed = stripAuthorAndKeywords(seed, author);
    const strippedCand = stripAuthorAndKeywords(candidate, author);
    const strippedRatio = titleSimilarityRatio(strippedSeed, strippedCand);
    const strippedTooSimilar = isTooSimilar(strippedSeed, strippedCand);
    console.log('\nAfter stripping author + keywords:');
    console.log('  stripped seed:', strippedSeed || '(empty)');
    console.log('  stripped candidate:', strippedCand || '(empty)');
    console.log(`  token-overlap ratio: ${strippedRatio.toFixed(3)} → isTooSimilar: ${strippedTooSimilar}`);
    if (strippedTooSimilar) {
      console.log('\nDecision: candidate is TOO SIMILAR to seed (after removing author+keywords) -> would be SKIPPED by autoplay.');
      return;
    }
  } else {
    console.log('\nAuthor not detected in seed title or not provided — skipping author-based stripping.');
  }

  // strip keywords only
  const sSeedNoAuthor = stripAuthorAndKeywords(seed, null);
  const sCandNoAuthor = stripAuthorAndKeywords(candidate, null);
  const sNoAuthorRatio = titleSimilarityRatio(sSeedNoAuthor, sCandNoAuthor);
  const sNoAuthorTooSimilar = isTooSimilar(sSeedNoAuthor, sCandNoAuthor);
  console.log('\nAfter stripping keywords only:');
  console.log('  stripped seed:', sSeedNoAuthor || '(empty)');
  console.log('  stripped candidate:', sCandNoAuthor || '(empty)');
  console.log(`  token-overlap ratio: ${sNoAuthorRatio.toFixed(3)} → isTooSimilar: ${sNoAuthorTooSimilar}`);

  if (sNoAuthorTooSimilar) {
    console.log('\nDecision: candidate is TOO SIMILAR to seed (after removing keywords) -> would be SKIPPED by autoplay.');
    return;
  }

  // final fallback: direct check already done
  if (directTooSimilar) {
    console.log('\nDecision: candidate is TOO SIMILAR to seed (direct check) -> would be SKIPPED by autoplay.');
    return;
  }

  console.log('\nDecision: candidate is NOT too similar -> can be considered by autoplay.');
}

main().catch(e => { console.error('Error:', e && e.message); });