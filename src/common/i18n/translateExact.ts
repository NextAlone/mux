/** Only exact dictionary entries are translations; Object prototype properties are not UI copy. */
export function translateExact(dictionary: Readonly<Record<string, string>>, text: string): string {
  return Object.prototype.hasOwnProperty.call(dictionary, text) ? dictionary[text] : text;
}
