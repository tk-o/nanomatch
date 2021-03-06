'use strict';

const regexNot = require('regex-not');
const toRegex = require('to-regex');

/**
 * Characters to use in negation regex (we want to "not" match
 * characters that are matched by other parsers)
 */

let cached;
const NOT_REGEX = '[\\[!*+?$^"\'.\\\\/]+';
const not = createTextRegex(NOT_REGEX);

/**
 * Nanomatch parsers
 */

module.exports = function(nanomatch, options) {
  const parser = nanomatch.parser;
  const opts = parser.options;

  parser.state = {
    slashes: 0,
    paths: []
  };

  parser.ast.state = parser.state;
  parser

    /**
     * Beginning-of-string
     */

    .set('prefix', function() {
      if (this.parsed) return;
      const m = this.match(/^\.[\\/]/);
      if (!m) return;
      this.state.strictOpen = !!this.options.strictOpen;
      this.state.addPrefix = true;
    })

    /**
     * Escape: "\\."
     */

    .set('escape', function() {
      if (this.isInside('bracket')) return;
      const pos = this.position();
      const m = this.match(/^(?:\\(.)|([$^]))/);
      if (!m) return;

      return pos({
        type: 'escape',
        val: m[2] || m[1]
      });
    })

    /**
     * Quoted strings
     */

    .set('quoted', function() {
      const pos = this.position();
      const m = this.match(/^["']/);
      if (!m) return;

      const quote = m[0];
      if (this.input.indexOf(quote) === -1) {
        return pos({
          type: 'escape',
          val: quote
        });
      }

      const tok = advanceTo(this.input, quote);
      this.consume(tok.len);

      return pos({
        type: 'quoted',
        val: tok.esc
      });
    })

    /**
     * Negations: "!"
     */

    .set('not', function() {
      const parsed = this.parsed;
      const pos = this.position();
      const m = this.match(this.notRegex || /^!+/);
      if (!m) return;
      let val = m[0];

      const isNegated = (val.length % 2) === 1;
      if (parsed === '' && !isNegated) {
        val = '';
      }

      // if nothing has been parsed, we know `!` is at the start,
      // so we need to wrap the result in a negation regex
      if (parsed === '' && isNegated && this.options.nonegate !== true) {
        this.bos.val = '(?!^(?:';
        this.append = ')$).*';
        val = '';
      }
      return pos({
        type: 'not',
        val
      });
    })

    /**
     * Dot: "."
     */

    .set('dot', function() {
      const parsed = this.parsed;
      const pos = this.position();
      const m = this.match(/^\.+/);
      if (!m) return;

      const val = m[0];
      this.state.dot = val === '.' && (parsed === '' || parsed.slice(-1) === '/');

      return pos({
        type: 'dot',
        dotfiles: this.state.dot,
        val
      });
    })

    /**
     * Plus: "+"
     */

    .capture('plus', /^\+(?!\()/)

    /**
     * Question mark: "?"
     */

    .set('qmark', function() {
      const parsed = this.parsed;
      const pos = this.position();
      const m = this.match(/^\?+(?!\()/);
      if (!m) return;

      this.state.metachar = true;
      this.state.qmark = true;

      return pos({
        type: 'qmark',
        parsed: parsed,
        val: m[0]
      });
    })

    /**
     * Globstar: "**"
     */

    .set('globstar', function() {
      const parsed = this.parsed;
      const pos = this.position();
      const m = this.match(/^\*{2}(?![*(])(?=[,)/]|$)/);
      if (!m) return;

      const type = opts.noglobstar !== true ? 'globstar' : 'star';
      const node = pos({type, parsed});
      this.state.metachar = true;

      while (this.input.slice(0, 4) === '/**/') {
        this.input = this.input.slice(3);
      }

      node.isInside = {
        brace: this.isInside('brace'),
        paren: this.isInside('paren')
      };

      if (type === 'globstar') {
        this.state.globstar = true;
        node.val = '**';

      } else {
        this.state.star = true;
        node.val = '*';
      }

      return node;
    })

    /**
     * Star: "*"
     */

    .set('star', function() {
      const pos = this.position();
      const starRe = /^(?:\*(?![*(])|[*]{3,}(?!\()|[*]{2}(?![(/]|$)|\*(?=\*\())/;
      const m = this.match(starRe);
      if (!m) return;

      this.state.metachar = true;
      this.state.star = true;
      return pos({
        type: 'star',
        val: m[0]
      });
    })

    /**
     * Slash: "/"
     */

    .set('slash', function() {
      const pos = this.position();
      const m = this.match(/^\//);
      if (!m) return;

      this.state.slashes++;
      return pos({
        type: 'slash',
        val: m[0]
      });
    })

    /**
     * Backslash: "\\"
     */

    .set('backslash', function() {
      const pos = this.position();
      const m = this.match(/^\\(?![*+?(){}[\]'"])/);
      if (!m) return;

      let val = m[0];

      if (this.isInside('bracket')) {
        val = '\\';
      } else if (val.length > 1) {
        val = '\\\\';
      }

      return pos({
        type: 'backslash',
        val
      });
    })

    /**
     * Square: "[.]"
     */

    .set('square', function() {
      if (this.isInside('bracket')) return;
      const pos = this.position();
      const m = this.match(/^\[([^!^\\])\]/);
      if (!m) return;

      return pos({
        type: 'square',
        val: m[1]
      });
    })

    /**
     * Brackets: "[...]" (basic, this can be overridden by other parsers)
     */

    .set('bracket', function() {
      const pos = this.position();
      const m = this.match(/^(?:\[([!^]?)([^\]]+|\]-)(\]|[^*+?]+)|\[)/);
      if (!m) return;

      let val = m[0];
      const negated = m[1] ? '^' : '';
      let inner = (m[2] || '').replace(/\\\\+/, '\\\\');
      const close = m[3] || '';

      if (m[2] && inner.length < m[2].length) {
        val = val.replace(/\\\\+/, '\\\\');
      }

      const esc = this.input.slice(0, 2);
      if (inner === '' && esc === '\\]') {
        inner += esc;
        this.consume(2);

        const str = this.input;
        let idx = -1;
        let ch;

        while ((ch = str[++idx])) {
          this.consume(1);
          if (ch === ']') {
            close = ch;
            break;
          }
          inner += ch;
        }
      }

      return pos({
        type: 'bracket',
        val,
        escaped: close !== ']',
        negated,
        inner,
        close
      });
    })

    /**
     * Text
     */

    .set('text', function() {
      if (this.isInside('bracket')) return;
      const pos = this.position();
      const m = this.match(not);
      if (!m || !m[0]) return;

      return pos({
        type: 'text',
        val: m[0]
      });
    });

  /**
   * Allow custom parsers to be passed on options
   */

  if (options && typeof options.parsers === 'function') {
    options.parsers(nanomatch.parser);
  }
};

/**
 * Advance to the next non-escaped character
 */

function advanceTo(input, endChar) {
  let ch = input.charAt(0);
  const tok = { len: 1, val: '', esc: '' };
  let idx = 0;

  function advance() {
    if (ch !== '\\') {
      tok.esc += '\\' + ch;
      tok.val += ch;
    }

    ch = input.charAt(++idx);
    tok.len++;

    if (ch === '\\') {
      advance();
      advance();
    }
  }

  while (ch && ch !== endChar) {
    advance();
  }
  return tok;
}

/**
 * Create text regex
 */

function createTextRegex(pattern) {
  if (cached) return cached;
  const opts = {contains: true, strictClose: false};
  const not = regexNot.create(pattern, opts);
  const re = toRegex('^(?:[*]\\((?=.)|' + not + ')', opts);
  return (cached = re);
}

/**
 * Expose negation string
 */

module.exports.not = NOT_REGEX;
