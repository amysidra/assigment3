import picomatch from "picomatch";
function compileMatcher(pattern) {
  if (pattern instanceof RegExp) {
    return {
      pattern,
      test: (value) => {
        pattern.lastIndex = 0;
        return pattern.test(value);
      }
    };
  }
  const isMatch = picomatch(pattern, { dot: true });
  return { pattern, test: isMatch };
}
function compileMatchers(patterns) {
  return patterns.map(compileMatcher);
}
function matchesAny(value, matchers) {
  for (const matcher of matchers) {
    if (matcher.test(value)) {
      return matcher;
    }
  }
  return void 0;
}
export {
  compileMatcher,
  compileMatchers,
  matchesAny
};
//# sourceMappingURL=matchers.js.map
