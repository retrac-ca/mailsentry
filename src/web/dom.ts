export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElementProps {
  class?: string;
  text?: string;
  id?: string;
  title?: string;
  href?: string;
  type?: string;
  name?: string;
  value?: string | number;
  placeholder?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  required?: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  multiple?: boolean;
  hidden?: boolean;
  role?: string;
  rel?: string;
  target?: string;
  scope?: string;
  colSpan?: number;
  rows?: number;
  autocomplete?: string;
  spellcheck?: boolean;
  novalidate?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-live"?: string;
  "aria-current"?: string;
  "aria-hidden"?: string;
  "aria-disabled"?: string;
  "aria-invalid"?: string;
  for?: string;
  open?: boolean;
  maxLength?: number;
  inputMode?: string;
  tabindex?: string | number;
  dataset?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = String(value);
    else if (key === "text") element.textContent = String(value);
    else if (key === "on") {
      for (const [event, handler] of Object.entries(value as Record<string, (event: Event) => void>)) {
        element.addEventListener(event, handler);
      }
    } else if (key === "dataset") {
      Object.assign(element.dataset, value as Record<string, string>);
    } else if (key in element) {
      (element as unknown as Record<string, unknown>)[key] = value;
    } else {
      element.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function alertBox(
  kind: "info" | "warning" | "danger" | "success",
  title: string,
  body?: Child[],
): HTMLElement {
  return h("div", { class: `alert ${kind}`, role: kind === "danger" ? "alert" : "status" }, [
    h("h3", { text: title }),
    ...(body ?? []),
  ]);
}

export function emptyState(title: string, body: string): HTMLElement {
  return h("div", { class: "empty" }, [h("h2", { text: title }), h("p", { text: body })]);
}

export function badge(text: string, variant: string): HTMLElement {
  return h("span", { class: `badge ${variant}`, text });
}
