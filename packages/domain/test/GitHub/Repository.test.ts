import { describe, it } from "@effect/vitest"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import { TestSchema } from "effect/testing"
import {
  GitHubInstallationId,
  GitHubInstallationIdFromStringOrNumber,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryDatabaseIdFromStringOrNumber,
  GitHubRepositoryNodeId,
} from "@janitor/domain/GitHub/Id"
import {
  GitHubRepository,
  GitHubRepositoryFullNameFromString,
  GitHubRepositoryId,
} from "@janitor/domain/GitHub/Repository"

describe("GitHub repository schemas", () => {
  it("decodes a repository full name", async () => {
    const decoding = new TestSchema.Asserts(GitHubRepositoryFullNameFromString).decoding()

    await decoding.succeed("effect/janitor", {
      owner: "effect",
      repo: "janitor",
    })

    await decoding.fail("effect/janitor/extra", "Expected a string matching template literal parts")
  })

  it("encodes a repository full name", async () => {
    const encoding = new TestSchema.Asserts(GitHubRepositoryFullNameFromString).encoding()

    await encoding.succeed({ owner: "effect", repo: "janitor" }, "effect/janitor")
  })

  it("normalizes string and number repository database IDs", async () => {
    const decoding = new TestSchema.Asserts(GitHubRepositoryDatabaseIdFromStringOrNumber).decoding()
    const expected = GitHubRepositoryDatabaseId.make("123")

    await decoding.succeed("123", expected)
    await decoding.succeed(123, expected)
  })

  it("normalizes string and number installation IDs", async () => {
    const decoding = new TestSchema.Asserts(GitHubInstallationIdFromStringOrNumber).decoding()
    const expected = GitHubInstallationId.make("456")

    await decoding.succeed("456", expected)
    await decoding.succeed(456, expected)
  })

  it("decodes a Postgres repository row", async () => {
    const decoding = new TestSchema.Asserts(GitHubRepository).decoding()
    const createdAt = 1_725_000_000_000
    const updatedAt = 1_725_000_100_000

    await decoding.succeed(
      {
        id: "01234567-89ab-7607-8809-0a0b0c0d0e0f",
        githubDatabaseId: "123",
        githubNodeId: "R_kgDOJanitor",
        owner: "effect",
        repo: "janitor",
        isPrivate: true,
        installationId: "456",
        enabled: false,
        rulesRevision: 1,
        createdAt,
        updatedAt,
        deletedAt: null,
      },
      GitHubRepository.make({
        id: GitHubRepositoryId.make("01234567-89ab-7607-8809-0a0b0c0d0e0f"),
        githubDatabaseId: GitHubRepositoryDatabaseId.make("123"),
        githubNodeId: GitHubRepositoryNodeId.make("R_kgDOJanitor"),
        owner: "effect",
        repo: "janitor",
        isPrivate: true,
        installationId: GitHubInstallationId.make("456"),
        enabled: false,
        rulesRevision: 1,
        createdAt: DateTime.makeUnsafe(createdAt),
        updatedAt: DateTime.makeUnsafe(updatedAt),
        deletedAt: Option.none(),
      }),
    )
  })
})
