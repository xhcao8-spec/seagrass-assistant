const URL_ONLY_PATTERN = /^(?:https?:\/\/|www\.)\S+$/iu;
const EMAIL_ONLY_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PHONE_ONLY_PATTERN = /^\+?[\d\s().-]{5,}$/u;
const TIME_ONLY_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/u;
const DATE_ONLY_PATTERN = /^(?:\d{2,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|\d{1,2}月\d{1,2}日)(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/u;
const FILE_META_ONLY_PATTERN = /^\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|字节)(?:\s*[·|/]\s*\d{1,2}:\d{2}(?::\d{2})?)?$/iu;
const NON_LANGUAGE_ONLY_PATTERN = /^[\p{N}\p{P}\p{S}\p{Z}\p{M}]+$/u;

function normaliseMessageText(value) {
  return String(value ?? '').replace(/\u00a0/gu, ' ').trim();
}

/**
 * Returns true only when a value contains natural-language text worth sending
 * to a translation provider. Mixed text and numbers are intentionally kept.
 */
function isTranslatableMessageText(value) {
  const text = normaliseMessageText(value);
  if (!text) return false;
  if (
    URL_ONLY_PATTERN.test(text)
    || EMAIL_ONLY_PATTERN.test(text)
    || PHONE_ONLY_PATTERN.test(text)
    || TIME_ONLY_PATTERN.test(text)
    || DATE_ONLY_PATTERN.test(text)
    || FILE_META_ONLY_PATTERN.test(text)
    || NON_LANGUAGE_ONLY_PATTERN.test(text)
  ) return false;

  return /\p{L}/u.test(text);
}

module.exports = {
  isTranslatableMessageText,
  normaliseMessageText,
};
