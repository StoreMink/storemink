/** Shown wherever a store that has not opened yet refuses something. Client-
 *  safe: the server guard (lib/store/storefront-access.ts) is server-only, and
 *  storefront forms need the same sentence without importing the database. */
export const STORE_CLOSED_MESSAGE =
  "This store hasn't opened yet, so orders, accounts and forms are turned off.";

/** The storefront route that asks a visitor for the store password. Reserved
 *  in lib/sections/registry.ts so no merchant page can take the slug. */
export const STOREFRONT_PASSWORD_PATH = "/password";
