/** Normalized address suggestions. Missing values stay empty for human review. */
export interface PickedLocation {
  lat: number | null;
  lng: number | null;
  address: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
}
export interface GoogleAddressResult {
  formatted_address?: string;
  address_components?: {
    long_name: string;
    short_name: string;
    types: string[];
  }[];
}
export function googleAddress(
  results: GoogleAddressResult[],
): Omit<PickedLocation, "lat" | "lng"> {
  const parts = results.flatMap((result) => result.address_components ?? []);
  const find = (...types: string[]) =>
    types
      .map((type) => parts.find((p) => p.types.includes(type)))
      .find(Boolean);
  const join = (values: (string | undefined)[], separator = ", ") =>
    [...new Set(values.filter(Boolean))].join(separator);
  return {
    address: results[0]?.formatted_address ?? "",
    addressLine1: join([
      find("premise")?.long_name,
      join([find("street_number")?.long_name, find("route")?.long_name], " "),
    ]),
    addressLine2: join([
      find("subpremise")?.long_name,
      find("sublocality_level_1", "sublocality")?.long_name,
      find("neighborhood")?.long_name,
    ]),
    city:
      find(
        "locality",
        "postal_town",
        "administrative_area_level_3",
        "administrative_area_level_2",
      )?.long_name ?? "",
    state: find("administrative_area_level_1")?.long_name ?? "",
    postalCode: find("postal_code")?.long_name ?? "",
    countryCode: find("country")?.short_name.toUpperCase() ?? "",
  };
}
export function locationNotice(place: PickedLocation): string {
  const missing = [
    !place.addressLine1 && "street/building address",
    !place.city && "city",
    !place.state && "state/province",
    !place.postalCode && "postal/PIN code",
    !place.countryCode && "country",
  ].filter(Boolean);
  return missing.length
    ? `Location found, but we couldn't detect your ${missing.join(", ")}. Please check and complete those fields below.`
    : "Address details filled. Please check the building, street and postal/PIN code before continuing.";
}
