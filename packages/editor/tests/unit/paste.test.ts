import { describe, expect, it } from 'vitest';
import {
  cleanPastedHtml,
  pasteLostFormatting,
} from '../../src/client/text/paste.js';

describe('cleanPastedHtml', () => {
  it('removes styling, hints and event handlers and keeps tags and text', () => {
    const cleaned = cleanPastedHtml(
      '<p class="MsoNormal" style="color:red" id="a" lang="en" dir="ltr" onclick="x()" data-keep="1">Hello <b style="font-weight:700">world</b></p>',
    );
    expect(cleaned).toBe('<p data-keep="1">Hello <b>world</b></p>');
  });

  it('removes font and namespaced wrappers but keeps their text', () => {
    expect(
      cleanPastedHtml('<p><font face="Arial">one</font><o:p>two</o:p></p>'),
    ).toBe('<p>onetwo</p>');
  });

  it('removes meta, link, style, script and comments, with the content of style and script', () => {
    expect(
      cleanPastedHtml(
        '<meta charset="utf-8"><link rel="stylesheet" href="a.css"><style>p { color: red }</style><!--StartFragment--><p>text</p><script>alert(1)</script><!--[if gte mso 9]><xml>x</xml><![endif]-->',
      ),
    ).toBe('<p>text</p>');
  });

  it('is not fooled by a greater-than sign inside a quoted attribute value', () => {
    expect(cleanPastedHtml('<p title="a>b" style="color:red">hi</p>')).toBe(
      '<p title="a>b">hi</p>',
    );
    expect(cleanPastedHtml("<a href='x>y' onclick='z>()'>go</a>")).toBe(
      "<a href='x>y'>go</a>",
    );
  });

  it('is case-insensitive about tags and attributes', () => {
    expect(
      cleanPastedHtml('<P STYLE="x" ONCLICK="y">a</P><SCRIPT>b</SCRIPT>'),
    ).toBe('<p>a</p>');
  });

  it('puts a space after each table cell so their text does not run together', () => {
    expect(
      cleanPastedHtml('<table><tr><td>one</td><th>two</th></tr></table>'),
    ).toBe('<table><tr><td>one </td><th>two </th></tr></table>');
  });

  it('keeps a lone less-than sign as text', () => {
    expect(cleanPastedHtml('<p>1 < 2</p>')).toBe('<p>1 < 2</p>');
  });

  it('leaves plain text alone', () => {
    expect(cleanPastedHtml('just words')).toBe('just words');
  });
});

describe('pasteLostFormatting', () => {
  it.each([
    ['a style attribute', '<p style="color:red">x</p>'],
    ['a font tag', '<font color="red">x</font>'],
    ['an h1', '<h1>x</h1>'],
    ['a table', '<table><tr><td>x</td></tr></table>'],
    ['an image', '<p><img src="a.png"></p>'],
    ['an Mso class', '<p class="MsoNormal">x</p>'],
    ['a namespaced Word tag', '<p>x<o:p></o:p></p>'],
  ])('is true for %s', (_name, html) => {
    expect(pasteLostFormatting(html)).toBe(true);
  });

  it('is false for html of only the theme tags', () => {
    expect(
      pasteLostFormatting(
        '<p>a <b>b</b> <i>c</i> <u>d</u> <s>e</s> <a href="https://x.test">f</a><br></p><ul><li>g</li></ul><ol><li>h</li></ol>',
      ),
    ).toBe(false);
  });

  it("is false for the editor's own copy", () => {
    expect(
      pasteLostFormatting('<p data-pm-slice="1 1 []" style="x">a</p>'),
    ).toBe(false);
  });

  it('is not fooled by a style word inside an attribute value', () => {
    expect(pasteLostFormatting('<p title="style=x">a</p>')).toBe(false);
  });
});
