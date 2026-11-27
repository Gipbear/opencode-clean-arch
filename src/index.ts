import { COMMANDS, expandTemplate } from "./commands.ts"
import { SKILLS_DIR } from "./paths.ts"
import { loadSkills } from "./skills.ts"
import { TOOLS, toJsonSchema, toZodShape, type ToolEnv } from "./tools.ts"

/**
 * One default export serves both plugin generations:
 * - opencode 2.x calls `setup(ctx)` and registers through the skill/command/tool editors;
 * - opencode 1.x calls `server(input)` and reads the returned hooks.
 */
const plugin = {
  id: "clean-arch",

  async setup(ctx: any) {
    const directory: string = ctx.location?.directory ?? process.cwd()
    const skills = await loadSkills()

    await ctx.skill.transform((editor: any) => {
      for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill)
    })

    await ctx.command.transform((editor: any) => {
      for (const command of COMMANDS) {
        editor.add({
          name: command.name,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }: any) => {
            await ctx.session.prompt({
              ...prompt,
              sessionID,
              text: expandTemplate(command.template, prompt?.text ?? ""),
              delivery,
            })
          },
        })
      }
    })

    await ctx.tool.transform((editor: any) => {
      for (const spec of TOOLS) {
        editor.add({
          name: spec.name,
          description: spec.description,
          input: toJsonSchema(spec.params),
          execute: async (input: any, context: any) => {
            const env: ToolEnv = {
              directory,
              signal: context?.signal,
              progress: (status) => void context?.progress?.({ status }),
            }
            return { content: await spec.execute(input ?? {}, env) }
          },
        })
      }
    })
  },

  async server(input: any) {
    const { z } = await import("zod")
    const tools = Object.fromEntries(
      TOOLS.map((spec) => [
        spec.name,
        {
          description: spec.description,
          args: toZodShape(z, spec.params) as any,
          execute: async (args: any, context: any) =>
            spec.execute(args, {
              directory: context?.directory ?? input?.directory ?? process.cwd(),
              signal: context?.abort,
              progress: (title) => context?.metadata?.({ title }),
            }),
        },
      ]),
    )
    return {
      config: async (config: any) => {
        config.skills ??= {}
        const paths: string[] = config.skills.paths ?? []
        if (!paths.includes(SKILLS_DIR)) config.skills.paths = [...paths, SKILLS_DIR]
        config.command ??= {}
        for (const command of COMMANDS) {
          config.command[command.name] ??= { template: command.template, description: command.description }
        }
      },
      tool: tools,
    }
  },
}

export default plugin
