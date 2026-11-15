export type Decision = "approved" | "approved_with_notes" | "changes_requested"

export interface Annotation {
  kind: "comment" | "delete" | "replace"
  quote: string
  section: string
  text: string
}

export interface ReviewOutcome {
  decision: Decision | "timeout" | "cancelled"
  comment: string
  annotations: Annotation[]
  revision: number
  /** Path of the saved feedback, relative to the project directory. */
  record: string
  url: string
  diagramWarnings?: string[]
}
