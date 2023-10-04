/** @type {import("ts-jest/dist/types").InitialOptionsTsJest} */
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterEnv: ['./test/setup.js'],
};
