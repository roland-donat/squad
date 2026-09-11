import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, MarkdownText } from "../../src/ui/markdown/Markdown";

/**
 * The one test outside the server seam, and it is deliberate.
 *
 * Squad's rule is that a test pilots squad through its API, because a test that
 * breaks at the first reorganisation of modules tests the wrong thing. This one
 * is not that: it holds a **declared contract** and a **safety boundary**, both
 * of which are the point of the module rather than its shape. The contract is
 * the two subsets the MCP tools promise agents (ADR 0009); the boundary is that
 * prose a model wrote can never become markup in a page that holds the
 * developer's own session against squad's API.
 *
 * Rendered to a static string rather than to a DOM: no jsdom, no environment of
 * its own, and the string is exactly the right thing to assert on, since what
 * must never appear in it is a tag.
 */

const paint = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("the prose an agent wrote, painted", () => {
  it("paints the marks of the subset as elements", () => {
    const html = paint(<Markdown text={"Du **gras**, du `code` et une liste :\n\n- un\n- deux"} />);

    expect(html).toContain("<strong>gras</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>");
  });

  it("never turns what an agent wrote into markup", () => {
    // The whole reason this renderer builds elements instead of an HTML string.
    // A model that writes a tag gets a tag on screen, as characters.
    const html = paint(<Markdown text={'<script>fetch("/api/features")</script>'} />);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("refuses to make a link clickable on a scheme it does not vouch for", () => {
    // `javascript:` in an href is the one way agent prose could still act on
    // this page. The text survives, the link does not.
    const html = paint(<Markdown text="[cliquez ici](javascript:alert(1))" />);

    expect(html).not.toContain("href");
    expect(html).toContain("cliquez ici");

    const ordinary = paint(<Markdown text="[la doc](https://example.org)" />);
    expect(ordinary).toContain('href="https://example.org"');
  });

  it("flattens a heading and a table in the bounded subset, keeping their text", () => {
    // What the summary fields are painted with. A heading inside 240 characters
    // is noise and a table there is detail in disguise, but dropping what an
    // agent wrote would be worse than showing it plainly.
    const heading = paint(<Markdown text="# Le titre" subset="inline" />);
    expect(heading).not.toContain("<h4");
    expect(heading).toContain("Le titre");

    const table = paint(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} subset="inline" />);
    expect(table).not.toContain("<table");
    expect(table).toContain("1");
    expect(table).toContain("2");
  });

  it("paints a heading and a table in the full subset, below the panel's own", () => {
    const html = paint(<Markdown text={"# Le titre\n\n| a |\n|---|\n| 1 |"} subset="full" />);

    // `h4` and never above: the panel owns `h2` and `h3`, and an agent titling
    // its own prose is not titling the screen it lands on.
    expect(html).toContain("<h4>Le titre</h4>");
    expect(html).toContain("<table>");
  });

  it("keeps a fenced block whole in both subsets, since it is command output", () => {
    const fence = "```\nFAIL tests/seam/graph.test.ts\n  1 failed\n```";
    for (const subset of ["inline", "full"] as const) {
      const html = paint(<Markdown text={fence} subset={subset} />);
      expect(html).toContain("<pre>");
      expect(html).toContain("FAIL tests/seam/graph.test.ts");
    }
  });

  it("paints a line of prose without a box around it", () => {
    // What sits inside a row: a point of a test sheet next to its checkbox, an
    // option next to its radio. A block element there would break the line.
    const html = paint(<MarkdownText text="Le format de `kind`" />);

    expect(html).toContain("<code>kind</code>");
    expect(html).not.toContain("<p>");
    expect(html).not.toContain("<div");
  });

  it("paints nothing at all for an empty text", () => {
    expect(paint(<Markdown text="" />)).toBe("");
    expect(paint(<Markdown text={"   \n  "} />)).toBe("");
  });
});
