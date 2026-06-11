interface XMLParserOptions {
  ignoreAttributes?: boolean;
  removeNSPrefix?: boolean;
}

export class XMLParser {
  private ignoreAttributes: boolean;
  private removeNSPrefix: boolean;

  constructor(options: XMLParserOptions = {}) {
    this.ignoreAttributes = options.ignoreAttributes ?? false;
    this.removeNSPrefix = options.removeNSPrefix ?? true;
  }

  parse(xml: string): any {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const el = doc.documentElement;
    const tag = this.removeNSPrefix ? el.localName : el.tagName;
    return { [tag]: this.node(el) };
  }

  private node(el: Element): any {
    const result: any = {};

    if (!this.ignoreAttributes) {
      for (const attr of el.attributes) {
        if (attr.name === "xmlns" || attr.name.startsWith("xmlns:")) continue;
        result[`@${attr.name}`] = attr.value;
      }
    }

    const childEls: Element[] = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1) childEls.push(child as Element);
    }

    if (childEls.length === 0) {
      const text = el.textContent?.trim() ?? "";
      if (Object.keys(result).length === 0) {
        if (!text) return {};
        const num = Number(text);
        return isNaN(num) || text === "" ? text : num;
      }
      return text ? { ...result, "#text": text } : result;
    }

    const groups: Record<string, Element[]> = {};
    for (const child of childEls) {
      const name = this.removeNSPrefix ? child.localName : child.tagName;
      (groups[name] ??= []).push(child);
    }

    for (const [name, els] of Object.entries(groups)) {
      result[name] = els.length === 1 ? this.node(els[0]) : els.map((e) => this.node(e));
    }

    return result;
  }
}
