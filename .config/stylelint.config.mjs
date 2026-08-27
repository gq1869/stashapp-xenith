export default {
  extends: [
    "stylelint-config-standard",
    "stylelint-config-idiomatic-order"
  ],
  ignoreFiles: [
    "dist/**",
    ".idea/**"
  ],
  rules: {
    "custom-property-pattern": null
  }
};
