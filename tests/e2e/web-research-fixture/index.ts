import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "omo-e2e-web-research",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      for (const namespace of ["exa", "other"]) {
        editor.namespace({ name: namespace, description: "Isolated web research test tools" })
        for (const name of ["web_search_exa", "web_fetch_exa", "delete_document"]) {
          editor.add({
            name,
            description: "Returns its fixture tool ID without network access",
            input: { type: "object", properties: {}, additionalProperties: false },
            options: { namespace, codemode: true },
            execute: async () => ({ content: `${namespace}_${name}` }),
          })
        }
      }
    })
  },
})
