// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { MINK_ACTION_TOOLS } from "./product-action-types";
const socket = process.env.MINK_UNIFIED_TEST_SOCKET;
const suite = socket ? describe : describe.skip;
suite("automatic Mink access on disposable PostgreSQL", () => {
  it("backfills every store and provisions the complete registry on insert", async () => {
    if (
      !socket ||
      !/^\/private\/tmp\/mink-unified-pg\.[A-Za-z0-9]+$/.test(socket)
    )
      throw new Error(
        "Use a disposable socket, never an application database.",
      );
    const client = new Client({
      host: socket,
      port: 55486,
      database: "mink_unified_verify",
      user: process.env.USER,
    });
    await client.connect();
    try {
      const tables = await client.query(
        "select count(*)::int n from pg_tables where schemaname='public'",
      );
      expect(tables.rows[0].n).toBe(0);
      await client.query("begin");
      for (const role of ["anon", "authenticated", "app_user"]) {
        if (
          !(
            await client.query("select 1 from pg_roles where rolname=$1", [
              role,
            ])
          ).rowCount
        )
          await client.query(`create role ${role}`);
      }
      await client.query(`create table stores(id uuid primary key);
        create table mink_store_access(store_id uuid primary key references stores, enabled boolean, drafting_enabled boolean, phase text, invited_by text, invited_at timestamptz, updated_at timestamptz, check(not enabled or invited_by is not null and invited_at is not null));
        create table mink_action_tool_access(store_id uuid references stores, tool_name text, enabled boolean, enabled_by text, enabled_at timestamptz, updated_at timestamptz, primary key(store_id,tool_name));
        create table help_articles(slug text,status text,body text,updated_at timestamptz);
        insert into stores values('11111111-1111-4111-8111-111111111111');`);
      await client.query(
        readFileSync(
          "drizzle/migrations/sql/20261005_0157_catalog_freshness_mink_access.sql",
          "utf8",
        ),
      );
      await client.query(
        "insert into stores values('22222222-2222-4222-8222-222222222222')",
      );
      for (const id of [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]) {
        const access = await client.query(
          "select enabled,drafting_enabled from mink_store_access where store_id=$1",
          [id],
        );
        expect(access.rows).toEqual([
          { enabled: true, drafting_enabled: true },
        ]);
        const tools = await client.query(
          "select tool_name from mink_action_tool_access where store_id=$1 and enabled order by tool_name",
          [id],
        );
        expect(tools.rows.map((row) => row.tool_name)).toEqual(
          [...MINK_ACTION_TOOLS].sort(),
        );
      }
    } finally {
      await client.query("rollback");
      await client.end();
    }
  });
});
