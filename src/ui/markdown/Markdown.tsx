import { Fragment, useMemo, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";

/**
 * Markdown as React elements, never as HTML.
 *
 * Squad paints prose an agent wrote. Turning it into an HTML string and handing
 * that to `dangerouslySetInnerHTML` would mean owning a sanitiser for ever, on
 * content a model produces, in a page that holds the developer's own session
 * against squad's API. Building elements instead removes the question: there is
 * no path from the text to markup, so a `<script>` in the source is a `<script>`
 * on the screen, as characters.
 *
 * `marked` is used for its lexer alone, which is the part that is hard to get
 * right, and it is the only thing squad takes from it. The rendering is here,
 * where it can be held to the subsets the tools declare (ADR 0009): what an
 * agent is told it may write is what this paints, and nothing else.
 */

/**
 * Which subset applies, and it is not a matter of taste. `inline` is for the
 * bounded fields: a heading inside 240 characters is noise and a table there is
 * detail wearing a summary's clothes, so neither is painted as such. The text
 * is kept either way, flattened into a paragraph, because dropping what an
 * agent wrote would be worse than showing it plainly.
 */
export type MarkdownSubset = "inline" | "full";

export function Markdown({
  text,
  subset = "full",
  className,
}: {
  text: string;
  subset?: MarkdownSubset;
  className?: string;
}): ReactNode {
  // Parsed once per text, not once per render: a thread follows a session as it
  // writes, so this runs on every frame of a live conversation.
  const blocks = useMemo(() => renderBlocks(new Lexer().lex(text), subset), [text, subset]);
  if (text.trim() === "") return null;
  return <div className={className === undefined ? "prose" : `prose ${className}`}>{blocks}</div>;
}

/**
 * One line of prose, with its marks and nothing around them.
 *
 * The block renderer above wraps what it paints, which is right for a paragraph
 * and wrong inside a row: a point of a test sheet sits next to its checkbox and
 * its chip, and a `div` there would break the line it belongs to. Same subset,
 * same safety, no box.
 */
export function MarkdownText({ text }: { text: string }): ReactNode {
  const marks = useMemo(() => renderInline(new Lexer().inlineTokens(text)), [text]);
  return <>{marks}</>;
}

function renderBlocks(tokens: Token[], subset: MarkdownSubset): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (const [index, token] of tokens.entries()) {
    const node = renderBlock(token, subset, index);
    if (node !== null) rendered.push(node);
  }
  return rendered;
}

function renderBlock(token: Token, subset: MarkdownSubset, key: number): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return <p key={key}>{renderInline(token.tokens ?? [])}</p>;
    case "text": {
      const text = token as Tokens.Text;
      return <p key={key}>{text.tokens ? renderInline(text.tokens) : text.text}</p>;
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      // Flattened outside the full subset, and never painted above `h4` inside
      // it: the panel owns `h2` and `h3`, and an agent that writes `#` is
      // titling its own prose, not the screen it lands on.
      if (subset === "inline") return <p key={key}>{renderInline(heading.tokens)}</p>;
      const Tag = (["h4", "h5", "h6"][Math.min(heading.depth, 3) - 1] ?? "h6") as "h4" | "h5" | "h6";
      return <Tag key={key}>{renderInline(heading.tokens)}</Tag>;
    }
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        // A tight list holds lines, so its items are painted as lines. Letting
        // the block renderer have them would put a paragraph inside every
        // bullet, and paragraphs carry margins a list does not want.
        <li key={index}>
          {list.loose
            ? renderBlocks(item.tokens ?? [], subset)
            : renderTightItem(item.tokens ?? [], subset)}
        </li>
      ));
      return list.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
    }
    case "code": {
      const code = token as Tokens.Code;
      // Kept whole even in the bounded subset: a fenced block is nearly always
      // the output of a command, which is the evidence the developer reads
      // instead of running it again, and reflowing it would destroy it.
      return (
        <pre key={key}>
          <code>{code.text}</code>
        </pre>
      );
    }
    case "blockquote": {
      const quote = token as Tokens.Blockquote;
      const inside = renderBlocks(quote.tokens ?? [], subset);
      // Flattened in the bounded subset like a heading: what it says is kept,
      // the rule down its side is not. `inlineMarkdown` promises inline marks
      // and lists, and painting a block it never declared is a promise broken
      // in the reader's favour, which is still a promise broken.
      if (subset === "inline") return <Fragment key={key}>{inside}</Fragment>;
      return <blockquote key={key}>{inside}</blockquote>;
    }
    case "table": {
      const table = token as Tokens.Table;
      if (subset === "inline") {
        // Flattened rather than dropped: the cells are what was written.
        // The header first: the column names are exactly what makes a
        // flattened table readable, and dropping them left bare values.
        return (
          <p key={key}>
            {[table.header, ...table.rows]
              .map((row) => row.map((cell) => cell.text).join(" · "))
              .join(" ; ")}
          </p>
        );
      }
      return (
        <div key={key} className="prose__scroll">
          <table>
            <thead>
              <tr>
                {table.header.map((cell, index) => (
                  <th key={index}>{renderInline(cell.tokens)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index}>{renderInline(cell.tokens)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "hr":
      // Pure structure, no text: there is nothing of it to keep, and a rule
      // drawn across a 240 character summary is the noise the bound exists
      // to prevent.
      return subset === "inline" ? null : <hr key={key} />;
    // A link definition is plumbing for the link that uses it, and it has
    // already been used by the time this runs: painting its source put a stray
    // `[d]: https://...` under the paragraph that read fine.
    case "def":
      return null;
    default:
      // Everything else, `html` first among them, is shown as the characters it
      // is. This is the whole of the sanitising squad needs: there is no branch
      // from here to markup.
      return <p key={key}>{"raw" in token ? String(token.raw) : ""}</p>;
  }
}

/**
 * A tight list item: the line it holds, and whatever hangs under it.
 *
 * The line and the sub-list are two tokens, not one. Unwrapping only the first
 * and handing the rest to the inline renderer painted a nested bullet as its own
 * Markdown source, glued to the end of its parent: `- un / - deux` came out as
 * `un- deux`. Nested bullets with no blank line between them are the ordinary
 * shape of a ticket description, so this was the common case, not the corner.
 */
function renderTightItem(tokens: Token[], subset: MarkdownSubset): ReactNode[] {
  const rendered: ReactNode[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type === "text") {
      const text = token as Tokens.Text;
      rendered.push(
        <Fragment key={index}>
          {text.tokens ? renderInline(text.tokens) : text.text}
        </Fragment>,
      );
      continue;
    }
    const node = renderBlock(token, subset, index);
    if (node !== null) rendered.push(node);
  }
  return rendered;
}

function renderInline(tokens: Token[]): ReactNode[] {
  return tokens.map((token, key) => {
    switch (token.type) {
      // A bare string, not a span: wrapping every run of text put an element
      // between `strong` and its own words, which is noise in the tree and in
      // anything reading it. A fragment carries the key without rendering.
      case "text":
        return <Fragment key={key}>{(token as Tokens.Text).text}</Fragment>;
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case "strong":
        return <strong key={key}>{renderInline((token as Tokens.Strong).tokens)}</strong>;
      case "em":
        return <em key={key}>{renderInline((token as Tokens.Em).tokens)}</em>;
      case "del":
        return <del key={key}>{renderInline((token as Tokens.Del).tokens)}</del>;
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "br":
        return <br key={key} />;
      // Squad paints no image an agent names: it would be a request to a host
      // squad does not vouch for, from a page that holds the developer's
      // session. The alt text is what was meant to be conveyed, so it is what
      // is shown, rather than the source of a picture nobody will see.
      case "image":
        return <Fragment key={key}>{(token as Tokens.Image).text}</Fragment>;
      case "link": {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        // A scheme squad does not vouch for is not made clickable. `javascript:`
        // in an href is the one way agent prose could still act on this page,
        // and there is no reason to open the door for a link nobody asked for.
        if (href === null) return <span key={key}>{renderInline(link.tokens)}</span>;
        return (
          <a key={key} href={href} target="_blank" rel="noreferrer">
            {renderInline(link.tokens)}
          </a>
        );
      }
      default:
        return <Fragment key={key}>{"raw" in token ? String(token.raw) : ""}</Fragment>;
    }
  });
}

/** The three schemes worth a click from here, and nothing else. */
function safeHref(href: string): string | null {
  const scheme = /^(https?|mailto):/i;
  return scheme.test(href.trim()) ? href.trim() : null;
}
