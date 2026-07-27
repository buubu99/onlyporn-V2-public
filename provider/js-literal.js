function decodeJsStringLiteral(literal) {
  if (typeof literal !== 'string' || literal.length < 2) return '';
  const quote = literal[0];
  if ((quote !== '"' && quote !== "'") || literal.at(-1) !== quote) return '';

  let output = '';
  const body = literal.slice(1, -1);

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      output += char;
      continue;
    }

    index += 1;
    if (index >= body.length) break;
    const escaped = body[index];

    const simpleEscapes = {
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      0: '\0',
      '\\': '\\',
      '/': '/',
      '"': '"',
      "'": "'",
    };

    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      output += simpleEscapes[escaped];
      continue;
    }

    if (escaped === 'x') {
      const hex = body.slice(index + 1, index + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        output += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }

    if (escaped === 'u') {
      const hex = body.slice(index + 1, index + 5);
      if (/^[0-9a-f]{4}$/i.test(hex)) {
        output += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        continue;
      }
    }

    output += escaped;
  }

  return output;
}

function readQuotedLiteral(source, start) {
  const quote = source[start];
  let escaped = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) {
      return {
        literal: source.slice(start, index + 1),
        end: index + 1,
      };
    }
  }

  return null;
}

function extractAssignedObject(source, variableName) {
  if (typeof source !== 'string') return null;
  const marker = new RegExp(`\\b${variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const match = marker.exec(source);
  if (!match) return null;

  const objectStart = source.indexOf('{', match.index + match[0].length);
  if (objectStart === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(objectStart, index + 1);
    }
  }

  return null;
}

function splitTopLevel(source, separator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let escaped = false;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') braces += 1;
    else if (char === '}') braces -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (char === '(') parentheses += 1;
    else if (char === ')') parentheses -= 1;
    else if (
      char === separator &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(source.slice(start));
  return parts;
}

function findTopLevelColon(source) {
  const parts = splitTopLevel(source, ':');
  if (parts.length < 2) return -1;
  return parts[0].length;
}

function extractStringLiterals(source) {
  const values = [];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '"' && source[index] !== "'") continue;
    const parsed = readQuotedLiteral(source, index);
    if (!parsed) break;
    values.push(decodeJsStringLiteral(parsed.literal));
    index = parsed.end - 1;
  }

  return values;
}

function parseObjectStringValues(objectLiteral) {
  if (typeof objectLiteral !== 'string') return {};
  const trimmed = objectLiteral.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return {};

  const body = trimmed.slice(1, -1);
  const output = {};

  for (const rawEntry of splitTopLevel(body, ',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    const colonIndex = findTopLevelColon(entry);
    if (colonIndex === -1) continue;

    const rawKey = entry.slice(0, colonIndex).trim();
    const rawValue = entry.slice(colonIndex + 1).trim();
    let key = rawKey;

    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      key = decodeJsStringLiteral(rawKey);
    }

    if (!/^[\w -]+$/.test(key)) continue;
    const strings = extractStringLiterals(rawValue).filter(Boolean);
    if (strings.length) output[key] = strings;
  }

  return output;
}

function parseAssignedObjectStringValues(source, variableName) {
  const objectLiteral = extractAssignedObject(source, variableName);
  return objectLiteral ? parseObjectStringValues(objectLiteral) : {};
}

module.exports = {
  decodeJsStringLiteral,
  extractAssignedObject,
  extractStringLiterals,
  parseAssignedObjectStringValues,
  parseObjectStringValues,
  splitTopLevel,
};
