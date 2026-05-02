export function shSingleQuote(input) {
  const value = String(input);
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
