import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { SKILLS_DIR } from "./paths.ts"

export interface SkillFile {
  id: string
  name: string
  description: string
  path: string
  content: string
}

/** Split a SKILL.md into its single-line YAML frontmatter fields and the body. */
export function parseSkill(text: string): { fields: Record<string, string>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):\s*(.*)$/)
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, "$2").trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

export async function loadSkills(dir = SKILLS_DIR): Promise<SkillFile[]> {
  const skills: SkillFile[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, "SKILL.md")
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    const { fields, body } = parseSkill(text)
    skills.push({
      id: entry.name,
      name: fields.name || entry.name,
      description: fields.description || "",
      path: file,
      content: body,
    })
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id))
}
