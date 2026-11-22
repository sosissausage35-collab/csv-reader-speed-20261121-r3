// Fast CSV reader for make.fun csv-reader-speed-01-run-20261121 (round 3).
// Byte-identical to csv-reader 1.0.0 (kit vendor/csv-reader/index.js): the same
// broken-row policy (BOM, stray CR, quoted fields, doubled quotes, junk,
// unterminated quotes, short/long rows, error order and line/row numbers).
// Speed: indexOf-based scanning, a bulk split(',') fast path for plain lines,
// and streaming JSON output (no answer object is built in the timed path).

// JSON-escape a field value string into a quoted JSON string.
// Fast path: no '"', no '\\', no control char (<0x20) -> wrap verbatim.
const NEED_ESCAPE = /["\\\x00-\x1f]/;
function jsonStr(v) {
  if (!NEED_ESCAPE.test(v)) {
    return '"' + v + '"';
  }
  // Slow: escape ", \, and control chars (<0x20) with short forms or \u00XX.
  let out = '"';
  let start = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    let esc = null;
    if (c === 34) esc = '\\"';
    else if (c === 92) esc = '\\\\';
    else if (c === 10) esc = '\\n';
    else if (c === 13) esc = '\\r';
    else if (c === 9) esc = '\\t';
    else if (c === 8) esc = '\\b';
    else if (c === 12) esc = '\\f';
    else if (c < 32) esc = '\\u' + c.toString(16).padStart(4, '0');
    if (esc !== null) {
      out += v.slice(start, i) + esc;
      start = i + 1;
    }
  }
  out += v.slice(start) + '"';
  return out;
}

// Parse one case's decoded CSV text; return the JSON text of {columns, rows, errors}.
function parseCase(text, header) {
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;
  let width = -1;
  let columnsJson = null; // null until the first (header) record is seen
  const rowsOut = [];
  const errors = [];
  let rowCount = 0;

  while (true) {
    // Skip lines with no characters.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos++; line++; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= n) break;
    const recordLine = line;
    const recordRow = (header && columnsJson === null) ? null : rowCount;

    // End of the current physical line.
    let le = text.indexOf('\n', pos);
    if (le === -1) le = n;
    const q = text.indexOf('"', pos);
    const cr = text.indexOf('\r', pos);
    const hasQuote = q !== -1 && q < le;
    // A CR at le-1 is a CRLF only when a LF actually follows (le < n); at the end
    // of the text it is a lone (stray) CR.
    const hasStrayCR = cr !== -1 && cr < le && !(le < n && cr === le - 1);

    if (!hasQuote && !hasStrayCR) {
      // ---- fast path: whole record is one plain line, no quotes, no stray CR ----
      const segEnd = (le < n && le > pos && text.charCodeAt(le - 1) === 13) ? le - 1 : le;
      const fields = text.slice(pos, segEnd).split(',');
      if (width < 0) width = fields.length;
      if (header && columnsJson === null) {
        columnsJson = '["' + fields.join('","') + '"]';
      } else {
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          rowsOut.push('["' + fields.join('","') + '"' + ',""'.repeat(width - fields.length) + ']');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.slice(width) });
          rowsOut.push('["' + fields.slice(0, width).join('","') + '"]');
        } else {
          rowsOut.push('["' + fields.join('","') + '"]');
        }
        rowCount++;
      }
      pos = le + 1;
      line++;
      continue;
    }

    // ---- slow path: this record has quotes and/or stray CRs; scan field by field ----
    const pieces = []; // JSON pieces for the fields
    const extraVals = []; // values of fields beyond the width (for long_row extra)
    let quoted = false; // whether the last field read was quoted
    let ended = 0; // 0=COMMA 1=LINE_BREAK 2=END
    let fieldCount = 0;
    // line-end and stray-CR state for the current physical line; recomputed after a
    // quoted field that spans lines.
    let curLe = le;
    let curStray = hasStrayCR;

    while (true) {
      // read one field starting at pos
      quoted = text.charCodeAt(pos) === 34;
      if (!quoted) {
        // ---- unquoted field ----
        const c = text.indexOf(',', pos);
        if (c !== -1 && c < curLe) {
          // ends at a comma
          if (!curStray) {
            const v = text.slice(pos, c);
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
          } else {
            // careful: drop stray CRs (each is an error) inside [pos, c)
            let v = '';
            let i = pos;
            while (true) {
              const r = text.indexOf('\r', i);
              if (r === -1 || r >= c) { v += text.slice(i, c); break; }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              v += text.slice(i, r);
              i = r + 1;
            }
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
          }
          pos = c + 1;
          ended = 0;
        } else {
          // ends at the line break (curLe) or at the end of the text
          const isEnd = curLe >= n;
          let e = curLe;
          if (!isEnd && e > pos && text.charCodeAt(e - 1) === 13) e = e - 1; // CRLF
          if (!curStray) {
            const v = text.slice(pos, e);
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
          } else {
            let v = '';
            let i = pos;
            while (true) {
              const r = text.indexOf('\r', i);
              if (r === -1 || r >= e) { v += text.slice(i, e); break; }
              errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
              v += text.slice(i, r);
              i = r + 1;
            }
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
          }
          if (isEnd) { pos = n; ended = 2; }
          else { pos = curLe + 1; line++; ended = 1; }
        }
      } else {
        // ---- quoted field: opening quote at pos ----
        const open = pos;
        const openLine = line;
        let closeQ = -1;
        let doubled = false;
        let scan = pos + 1;
        while (true) {
          const qq = text.indexOf('"', scan);
          if (qq === -1) { closeQ = -1; break; }
          if (qq + 1 < n && text.charCodeAt(qq + 1) === 34) {
            doubled = true;
            scan = qq + 2;
            continue;
          }
          closeQ = qq;
          break;
        }
        if (closeQ === -1) {
          // Unterminated: the quote is literal; re-read as unquoted from open+1.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          // re-read as unquoted with starting value '"'
          const c = text.indexOf(',', pos);
          // recompute line end from the new pos
          curLe = text.indexOf('\n', pos);
          if (curLe === -1) curLe = n;
          curStray = false;
          {
            const r0 = text.indexOf('\r', pos);
            if (r0 !== -1 && r0 < curLe && r0 !== curLe - 1) curStray = true;
          }
          if (c !== -1 && c < curLe) {
            let v = '"';
            if (!curStray) {
              v += text.slice(pos, c);
            } else {
              let i = pos;
              while (true) {
                const r = text.indexOf('\r', i);
                if (r === -1 || r >= c) { v += text.slice(i, c); break; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                v += text.slice(i, r);
                i = r + 1;
              }
            }
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
            pos = c + 1;
            ended = 0;
          } else {
            const isEnd = curLe >= n;
            let e = curLe;
            if (!isEnd && e > pos && text.charCodeAt(e - 1) === 13) e = e - 1;
            let v = '"';
            if (!curStray) {
              v += text.slice(pos, e);
            } else {
              let i = pos;
              while (true) {
                const r = text.indexOf('\r', i);
                if (r === -1 || r >= e) { v += text.slice(i, e); break; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                v += text.slice(i, r);
                i = r + 1;
              }
            }
            pieces.push(jsonStr(v));
            if (width >= 0 && fieldCount >= width) extraVals.push(v);
            if (isEnd) { pos = n; ended = 2; }
            else { pos = curLe + 1; line++; ended = 1; }
          }
          fieldCount++;
          if (ended !== 0) break;
          continue;
        }
        // Closed at closeQ. Inner span [pos+1, closeQ).
        // Count/convert line breaks inside, and build the value.
        const innerHasCR = text.indexOf('\r', pos + 1) < closeQ && text.indexOf('\r', pos + 1) !== -1;
        const innerHasNL = text.indexOf('\n', pos + 1) < closeQ && text.indexOf('\n', pos + 1) !== -1;
        let value;
        let piece;
        if (!doubled && !innerHasCR && !innerHasNL) {
          value = text.slice(pos + 1, closeQ);
          piece = jsonStr(value);
        } else if (!doubled && !innerHasCR && innerHasNL) {
          // only LFs inside: escape them
          value = text.slice(pos + 1, closeQ);
          piece = jsonStr(value);
          // count the LFs for the line number
          let i = pos + 1;
          while (true) {
            const nl = text.indexOf('\n', i);
            if (nl === -1 || nl >= closeQ) break;
            line++;
            i = nl + 1;
          }
        } else {
          // general: build the value, handling "" -> " and \r -> \n; \n is kept.
          let v = '';
          let i = pos + 1;
          while (i < closeQ) {
            const ch = text[i];
            if (ch === '"') { v += '"'; i += 2; continue; }
            if (ch === '\r') {
              v += '\n';
              line++;
              i += (i + 1 < n && text[i + 1] === '\n') ? 2 : 1;
              continue;
            }
            if (ch === '\n') { v += '\n'; line++; i++; continue; }
            // copy a run up to the next '"', '\r' or '\n' (or closeQ)
            let nq = text.indexOf('"', i);
            let nr = text.indexOf('\r', i);
            let nn = text.indexOf('\n', i);
            let j = closeQ;
            if (nq !== -1 && nq < j) j = nq;
            if (nr !== -1 && nr < j) j = nr;
            if (nn !== -1 && nn < j) j = nn;
            v += text.slice(i, j);
            i = j;
          }
          value = v;
          piece = jsonStr(v);
        }
        // What follows the closing quote?
        const after = closeQ + 1;
        if (after >= n) {
          pieces.push(piece);
          if (width >= 0 && fieldCount >= width) extraVals.push(value);
          pos = n;
          ended = 2;
        } else {
          const ac = text.charCodeAt(after);
          if (ac === 44) { // ','
            pieces.push(piece);
            if (width >= 0 && fieldCount >= width) extraVals.push(value);
            pos = after + 1;
            ended = 0;
          } else if (ac === 10) {
            pieces.push(piece);
            if (width >= 0 && fieldCount >= width) extraVals.push(value);
            pos = after + 1;
            line++;
            ended = 1;
          } else if (ac === 13 && after + 1 < n && text.charCodeAt(after + 1) === 10) {
            pieces.push(piece);
            if (width >= 0 && fieldCount >= width) extraVals.push(value);
            pos = after + 2;
            line++;
            ended = 1;
          } else {
            // junk: read unquoted from `after`, appended to value
            let junk = value;
            let junkAdded = 0;
            let jp = after;
            // junk ends at ',' or a line break; stray CRs are dropped (errors)
            while (jp < n) {
              const cc = text.charCodeAt(jp);
              if (cc === 44) { jp++; ended = 0; break; }
              if (cc === 10) { jp++; line++; ended = 1; break; }
              if (cc === 13) {
                if (jp + 1 < n && text.charCodeAt(jp + 1) === 10) { jp += 2; line++; ended = 1; break; }
                errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                jp++;
                continue;
              }
              // copy a run up to the next ',', '\n' or '\r'
              let nc = text.indexOf(',', jp);
              let nn = text.indexOf('\n', jp);
              let nr = text.indexOf('\r', jp);
              let e = n;
              if (nc !== -1 && nc < e) e = nc;
              if (nn !== -1 && nn < e) e = nn;
              if (nr !== -1 && nr < e) e = nr;
              junk += text.slice(jp, e);
              junkAdded += e - jp;
              jp = e;
              if (jp >= n) { ended = 2; break; }
              // jp now points at a delimiter (',', '\n' or '\r'); the loop top handles it.
            }
            if (jp >= n && ended !== 0 && ended !== 1) ended = 2;
            if (junkAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
            pieces.push(jsonStr(junk));
            if (width >= 0 && fieldCount >= width) extraVals.push(junk);
            pos = jp;
          }
        }
        // If this quoted field spanned lines, the physical line end is stale; recompute.
        if (ended === 0) {
          // record continues; recompute curLe/curStray from pos
          curLe = text.indexOf('\n', pos);
          if (curLe === -1) curLe = n;
          curStray = false;
          const r0 = text.indexOf('\r', pos);
          if (r0 !== -1 && r0 < curLe && r0 !== curLe - 1) curStray = true;
        }
      }
      fieldCount++;
      if (ended !== 0) break;
    }

    // A record with a single empty unquoted field is no record.
    if (fieldCount === 1 && pieces.length === 1 && pieces[0] === '""' && !quoted) {
      continue;
    }
    if (width < 0) width = fieldCount;
    if (header && columnsJson === null) {
      columnsJson = '[' + pieces.join(',') + ']';
      continue;
    }
    if (fieldCount < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fieldCount });
      rowsOut.push('[' + pieces.join(',') + ',""'.repeat(width - fieldCount) + ']');
    } else if (fieldCount > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: extraVals });
      rowsOut.push('[' + pieces.slice(0, width).join(',') + ']');
    } else {
      rowsOut.push('[' + pieces.join(',') + ']');
    }
    rowCount++;
  }

  const col = header ? (columnsJson === null ? '[]' : columnsJson) : 'null';
  return '{"columns":' + col + ',"rows":[' + rowsOut.join(',') + '],"errors":' + JSON.stringify(errors) + '}';
}

/** csv-reader 1.0.0's answer for one case's input, {text, header}. */
export function run(input) {
  return JSON.parse(parseCase(String(input.text), input.header === true));
}

export { parseCase };
