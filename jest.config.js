export default {
  projects: [
    {
      displayName: "unit",
      testEnvironment: "node",
      testMatch: [
        "<rootDir>/tests/*.test.js"
      ],
      testPathIgnorePatterns: [
        "/node_modules/",
        "/.worktrees/",
        "/tests/integration/",
        "/tests/e2e/",
        "/tests/unit/"
      ]
    },
  ]
};
