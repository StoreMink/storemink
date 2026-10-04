import { expect, it } from "vitest";
import { googleAddress, locationNotice } from "./location-address";
const part = (type: string, name: string, short = name) => ({
  types: [type],
  long_name: name,
  short_name: short,
});
it("fills street/area and uses postal components beyond the first Google result", () => {
  const address = googleAddress([
    {
      formatted_address: "12 Main Road, Sample City",
      address_components: [
        part("premise", "Shop Building"),
        part("street_number", "12"),
        part("route", "Main Road"),
        part("sublocality_level_1", "Central Area"),
        part("locality", "Sample City"),
        part("administrative_area_level_1", "Punjab"),
        part("country", "India", "IN"),
      ],
    },
    { address_components: [part("postal_code", "151203")] },
  ]);
  expect(address).toMatchObject({
    addressLine1: "Shop Building, 12 Main Road",
    addressLine2: "Central Area",
    city: "Sample City",
    state: "Punjab",
    postalCode: "151203",
    countryCode: "IN",
  });
  expect(locationNotice({ ...address, lat: 30, lng: 74 })).toContain(
    "Please check",
  );
});
it("does not turn a city/plus-code result into a street or invent a PIN", () => {
  const address = googleAddress([
    {
      formatted_address: "ABCD+12, Faridkot, India",
      address_components: [
        part("locality", "Faridkot"),
        part("administrative_area_level_1", "Punjab"),
        part("country", "India", "IN"),
      ],
    },
  ]);
  expect(address.addressLine1).toBe("");
  expect(address.postalCode).toBe("");
  expect(locationNotice({ ...address, lat: 30, lng: 74 })).toContain(
    "street/building address, postal/PIN code",
  );
});
