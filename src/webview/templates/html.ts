// Tagged template literal for HTML - enables syntax highlighting with lit-html extension
export const html = (
  strings: TemplateStringsArray,
  ...values: unknown[]
): string =>
  strings.reduce((result, str, i) => result + str + (values[i] ?? ''), '')
