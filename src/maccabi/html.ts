/**
 * DOM helpers for the parsers of Maccabi's server-rendered pages, over htmlparser2.
 *
 * Their behaviour is pinned to the jQuery-style calls those parsers were first checked against:
 * entities in text and attributes are left as written (the parsers decode them), matches come back
 * in document order, and a detached node still owns its descendants.
 */
import { compile, selectAll } from "css-select";
import { type AnyNode, type Document, type Element, type ParentNode, Text } from "domhandler";
import { appendChild, getOuterHTML, isTag, prependChild, removeElement, replaceElement, textContent } from "domutils";
import { parseDocument } from "htmlparser2";

export type { Document, Element };

const AS_WRITTEN = { xmlMode: false, decodeEntities: false } as const;

/** Attributes whose presence is their meaning; they read as their own name whatever value they were given. */
const PRESENCE_ONLY = new Set(
  "autofocus autoplay async checked controls defer disabled hidden loop multiple open readonly required scoped selected".split(
    " ",
  ),
);

const space = (): Text => new Text(" ");

/** Parses forgivingly, adding no html, head or body the markup did not have. */
export function toDom(markup: string): Document {
  return parseDocument(markup, AS_WRITTEN);
}

/** Every descendant of `top` that matches; an absent `top` has none. */
export function query(css: string, top: ParentNode | undefined): Element[] {
  if (!top) return [];
  return selectAll<AnyNode, Element>(css, top.children, { context: [top] });
}

/** The direct element children of one parent or of several, parent by parent, narrowed by `css` when given. */
export function childElements(parents: ParentNode | readonly ParentNode[], css?: string): Element[] {
  const each: readonly ParentNode[] = Array.isArray(parents) ? parents : [parents as ParentNode];
  const direct = each.flatMap((parent) => parent.children.filter(isTag));
  return css === undefined ? direct : direct.filter(compile<AnyNode, Element>(css));
}

/** Whether this element matches the selector. */
export function fits(elem: Element, css: string): boolean {
  return compile<AnyNode, Element>(css)(elem);
}

/** The elements enclosing this one, from the closest outwards. */
export function parentsOf(elem: Element): Element[] {
  const enclosing: Element[] = [];
  let above = elem.parent;
  while (above && isTag(above)) {
    enclosing.push(above);
    above = above.parent;
  }
  return enclosing;
}

/** All text below the node or nodes. Script and style bodies count; comments do not. */
export function innerText(tag: AnyNode | AnyNode[]): string {
  return textContent(tag);
}

/**
 * An attribute's value. Three cases follow jQuery rather than the markup: a presence-only attribute
 * gives its name, a missing `value` on an `option` gives the option's text, and a missing `value` on
 * a checkbox or radio gives "on".
 */
export function attribute(elem: Element | undefined, label_: string): string | undefined {
  if (!elem) return undefined;
  const { attribs, name } = elem;
  if (Object.hasOwn(attribs, label_)) return PRESENCE_ONLY.has(label_.toLowerCase()) ? label_ : attribs[label_];
  if (label_ !== "value") return undefined;
  if (name === "option") return textContent(elem.children);
  const isToggle = name === "input" && (attribs.type === "radio" || attribs.type === "checkbox");
  return isToggle ? "on" : undefined;
}

/** Takes each node out of the tree. */
export function detach(nodes: readonly Element[]): void {
  for (const tag of nodes) removeElement(tag);
}

/** Puts one space in the place of each node that is still in the tree. */
export function swapForSpace(nodes: readonly Element[]): void {
  for (const tag of nodes) {
    if (!tag.parent) continue;
    replaceElement(tag, space());
    tag.prev = null;
    tag.next = null;
  }
}

/** Pads each element's content with a leading and a trailing space. */
export function surroundWithSpaces(elements: readonly Element[]): void {
  // All the leading spaces first: an element nested in another must not push the outer one's space.
  for (const elem of elements) prependChild(elem, space());
  for (const elem of elements) appendChild(elem, space());
}

/** Back to markup, as forgivingly as it was parsed. */
export function toMarkup(dom: Document): string {
  return getOuterHTML(dom.children, AS_WRITTEN);
}
