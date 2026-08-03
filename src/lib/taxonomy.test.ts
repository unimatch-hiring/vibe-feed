import { describe, it, expect } from "vitest";
import {
  canonicalTopic,
  isEditorialSection,
  splitTag,
  tagExpressesTopic,
  topicTokens,
} from "./taxonomy";

describe("canonicalTopic", () => {
  it("folds spelling variants of one topic together", () => {
    expect(canonicalTopic("  Open Source ")).toBe("open source");
    expect(canonicalTopic("opensource")).toBe("open source");
    expect(canonicalTopic("MachineLearning")).toBe("machine learning");
  });
});

describe("tagExpressesTopic", () => {
  it("matches a topic against the words of a tag, across source vocabularies", () => {
    // dev.to writes "ai", The GitHub Blog writes "AI & ML".
    expect(tagExpressesTopic("AI & ML", topicTokens("ai"))).toBe(true);
    expect(tagExpressesTopic("GitHub Copilot CLI", topicTokens("github copilot"))).toBe(true);
  });

  it("does not match a different word that merely starts the same", () => {
    expect(tagExpressesTopic("aim", topicTokens("ai"))).toBe(false);
    expect(tagExpressesTopic("AI & ML", topicTokens("ai security"))).toBe(false);
  });
});

describe("isEditorialSection", () => {
  it("recognises publication sections, which are not interests", () => {
    expect(isEditorialSection("News & insights")).toBe(true);
    expect(isEditorialSection("Company news")).toBe(true);
    expect(isEditorialSection("security")).toBe(false);
  });
});

describe("splitTag", () => {
  it("splits a tag on connectors but never inside a compound name", () => {
    expect(splitTag("AI & ML")).toEqual(["ai", "ml"]);
    expect(splitTag("Docker, Kubernetes")).toEqual(["docker", "kubernetes"]);
    expect(splitTag("GitHub Copilot CLI")).toEqual(["github copilot cli"]);
    expect(splitTag("opensource")).toEqual(["open source"]);
  });
});
