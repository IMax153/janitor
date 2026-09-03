import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  type Completion,
  type CompletionContext,
  type CompletionSource,
  completionKeymap,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { json, jsonParseLinter } from "@codemirror/lang-json"
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxTree,
} from "@codemirror/language"
import { lintGutter, linter, lintKeymap } from "@codemirror/lint"
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search"
import { Compartment, type EditorState, type Extension } from "@codemirror/state"
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  ViewPlugin,
} from "@codemirror/view"
import type { SyntaxNode } from "@lezer/common"
import { githubDark, githubLight } from "@uiw/codemirror-theme-github"
import type { FactDescription } from "@/components/labeling-wire"

/**
 * The policy source editor: JSON with completion for facts, operators,
 * quantifiers, and policy names. Everything offered comes from the fact
 * catalog the server publishes, so completion cannot drift from the schema.
 */

export interface EditorContext {
  readonly catalog: ReadonlyArray<FactDescription>
  readonly policyNames: ReadonlyArray<string>
}

const groupKeys = ["all", "any", "not"] as const
const rootKeys = ["target", "appliesWhen", "matchesWhen", "classify"] as const

const stringValue = (state: EditorState, node: SyntaxNode | null): string | null => {
  if (node === null) return null
  try {
    const value: unknown = JSON.parse(state.sliceDoc(node.from, node.to))
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

const propertyName = (state: EditorState, property: SyntaxNode): string | null =>
  stringValue(state, property.getChild("PropertyName"))

/** The string value of a sibling property in the enclosing object. */
const siblingValue = (state: EditorState, object: SyntaxNode, name: string): string | null => {
  for (let child = object.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === "Property" && propertyName(state, child) === name) {
      const value = child.lastChild
      return value === null || value.name === "PropertyName" ? null : stringValue(state, value)
    }
  }
  return null
}

const enclosing = (node: SyntaxNode | null, name: string): SyntaxNode | null => {
  let current = node
  while (current !== null && current.name !== name) current = current.parent
  return current
}

const completion = (label: string, detail: string, type = "keyword"): Completion => ({
  label,
  detail,
  type,
})

const quoted = (label: string, detail: string, type = "keyword"): Completion => ({
  label,
  apply: `"${label}"`,
  detail,
  type,
})

/** Which fact a `where` item belongs to, by walking up to the quantified object. */
const collectionFact = (
  state: EditorState,
  object: SyntaxNode,
  catalog: ReadonlyArray<FactDescription>,
): FactDescription | undefined => {
  let current: SyntaxNode | null = object
  while (current !== null) {
    if (current.name === "Object") {
      for (const key of ["some", "every", "none"]) {
        const fact = siblingValue(state, current, key)
        if (fact !== null) return catalog.find((entry) => entry.name === fact)
      }
    }
    current = current.parent
  }
  return undefined
}

export const policyCompletionSource =
  (context: EditorContext): CompletionSource =>
  (completionContext: CompletionContext) => {
    const { state, pos } = completionContext
    const tree = syntaxTree(state)
    const node = tree.resolveInner(pos, -1)
    const word = completionContext.matchBefore(/"?[\w.]*/)
    if (word === null && !completionContext.explicit) return null
    const from = word === null ? pos : word.from + (word.text.startsWith('"') ? 1 : 0)
    const property = enclosing(node, "Property")
    const object = enclosing(node, "Object")
    const inKey = property !== null && node.name === "PropertyName"
    const options: Array<Completion> = []

    if (inKey || (object !== null && property === null)) {
      // Keys: root keys at the top, group keys, fact predicate keys, quantifiers, policy.
      const parentIsRoot = object !== null && object.parent?.name === "JsonText"
      for (const key of parentIsRoot ? rootKeys : []) options.push(quoted(key, "program"))
      for (const key of groupKeys) options.push(quoted(key, "group"))
      for (const key of ["fact", "operator", "value", "caseSensitive"]) {
        options.push(quoted(key, "predicate", "property"))
      }
      for (const key of ["some", "every", "none", "where"]) options.push(quoted(key, "collection"))
      options.push(quoted("policy", "reference"))
      for (const key of ["prompt", "evidence", "minimumConfidence"]) {
        options.push(quoted(key, "classifier", "property"))
      }
      return { from, options, validFor: /^"?[\w.]*$/ }
    }

    if (property === null || object === null) return null
    const key = propertyName(state, property)
    switch (key) {
      case "fact": {
        const inside = collectionFact(state, object, context.catalog)
        if (inside !== undefined) {
          for (const field of inside.fields)
            options.push(quoted(field.name, `${inside.name} ${field.type}`))
        } else {
          for (const fact of context.catalog) {
            if (fact.type !== "Collection") {
              options.push(quoted(fact.name, `${fact.type} · ${fact.kinds.join(", ")}`))
            }
          }
        }
        break
      }
      case "operator": {
        const inside = collectionFact(state, object, context.catalog)
        const fieldName = siblingValue(state, object, "fact")
        const field = inside?.fields.find((entry) => entry.name === fieldName)
        const fact = context.catalog.find((entry) => entry.name === fieldName)
        const operators = field?.operators ?? fact?.operators ?? []
        for (const operator of operators) options.push(quoted(operator, "operator"))
        break
      }
      case "some":
      case "every":
      case "none":
        for (const fact of context.catalog) {
          if (fact.type === "Collection") options.push(quoted(fact.name, fact.description))
        }
        break
      case "policy":
        for (const name of context.policyNames) options.push(quoted(name, "policy"))
        break
      case "target":
        options.push(quoted("pull_request", "target"), quoted("issue", "target"))
        break
      case "evidence":
        for (const fact of context.catalog) {
          if (fact.type !== "Collection") options.push(quoted(fact.name, `evidence · ${fact.type}`))
        }
        break
      case "value": {
        const fieldName = siblingValue(state, object, "fact")
        const fact = context.catalog.find((entry) => entry.name === fieldName)
        if (fact?.type === "Flag")
          options.push(completion("true", "flag"), completion("false", "flag"))
        if (fieldName === "state") options.push(quoted("open", "state"), quoted("closed", "state"))
        break
      }
      default:
        return null
    }
    return options.length === 0 ? null : { from, options, validFor: /^"?[\w.]*$/ }
  }

const editorTheme = EditorView.theme({
  "&": { minHeight: "18rem", maxHeight: "36rem", fontSize: "13px" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  ".cm-content": { padding: "12px 0" },
  "&.cm-focused": { outline: "none" },
})

const currentTheme = (): Extension =>
  document.documentElement.classList.contains("dark") ? githubDark : githubLight

/** Follows the app's theme switcher, which toggles `dark` on the root element. */
const followTheme = (theme: Compartment) =>
  ViewPlugin.fromClass(
    class {
      readonly observer: MutationObserver
      constructor(view: EditorView) {
        this.observer = new MutationObserver(() => {
          view.dispatch({ effects: theme.reconfigure(currentTheme()) })
        })
        this.observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["class"],
        })
      }
      destroy() {
        this.observer.disconnect()
      }
    },
  )

export const createPolicySourceEditor = (input: {
  readonly element: HTMLElement
  readonly initialSource: string
  readonly context: EditorContext
  readonly onChange: (source: string) => void
}): EditorView => {
  const theme = new Compartment()
  return new EditorView({
    doc: input.initialSource,
    parent: input.element,
    extensions: [
      theme.of(currentTheme()),
      followTheme(theme),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      json(),
      linter(jsonParseLinter()),
      lintGutter(),
      autocompletion({
        override: [policyCompletionSource(input.context)],
        activateOnTyping: true,
        selectOnOpen: true,
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      EditorView.contentAttributes.of({ "aria-label": "Policy program JSON" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) input.onChange(update.state.doc.toString())
      }),
      editorTheme,
    ],
  })
}
