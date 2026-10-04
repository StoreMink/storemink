// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PickedLocation } from "./location-address";
const empty: PickedLocation = {
  lat: null,
  lng: null,
  address: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
  countryCode: "",
};
const result = [
  {
    formatted_address: "12 Main Road, Sample City",
    address_components: [
      { types: ["street_number"], long_name: "12", short_name: "12" },
      { types: ["route"], long_name: "Main Road", short_name: "Main Road" },
      {
        types: ["sublocality_level_1"],
        long_name: "Central Area",
        short_name: "Central Area",
      },
      {
        types: ["locality"],
        long_name: "Sample City",
        short_name: "Sample City",
      },
      {
        types: ["administrative_area_level_1"],
        long_name: "Punjab",
        short_name: "PB",
      },
      { types: ["postal_code"], long_name: "151203", short_name: "151203" },
      { types: ["country"], long_name: "India", short_name: "IN" },
    ],
  },
];
const getPosition = vi.fn(
  (success: PositionCallback, error?: PositionErrorCallback) => {
    void error;
    success({ coords: { latitude: 30, longitude: 74 } } as GeolocationPosition);
  },
);
function maps(geocode = vi.fn((_request, callback) => callback(result, "OK"))) {
  return {
    maps: {
      Map: vi.fn(function () {
        return { addListener: vi.fn(), setCenter: vi.fn(), setZoom: vi.fn() };
      }),
      Marker: vi.fn(function () {
        return { addListener: vi.fn(), setPosition: vi.fn() };
      }),
      Geocoder: vi.fn(function () {
        return { geocode };
      }),
    },
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "");
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: getPosition },
  });
  getPosition.mockImplementation((success) =>
    success({ coords: { latitude: 30, longitude: 74 } } as GeolocationPosition),
  );
  delete window.google;
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.google;
  delete window.__smSignupMapsLoaded;
  document
    .querySelectorAll('script[src*="maps.googleapis.com"]')
    .forEach((s) => s.remove());
});
it("fills all known Google address fields and asks for review", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-key");
  window.google = maps();
  const { LocationPicker } = await import("./location-picker");
  const changed = vi.fn();
  render(<LocationPicker value={empty} onChange={changed} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Use my current location" }),
  );
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        addressLine1: "12 Main Road",
        addressLine2: "Central Area",
        city: "Sample City",
        postalCode: "151203",
        countryCode: "IN",
      }),
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Address details filled",
  );
});
it("reports exactly the missing street and PIN in the keyless fallback", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        city: "Faridkot",
        principalSubdivision: "Punjab",
        countryName: "India",
        countryCode: "IN",
      }),
    })),
  );
  const { LocationPicker } = await import("./location-picker");
  const changed = vi.fn();
  render(<LocationPicker value={empty} onChange={changed} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Use my current location" }),
  );
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        city: "Faridkot",
        addressLine1: "",
        postalCode: "",
      }),
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "street/building address, postal/PIN code",
  );
  expect(screen.getByRole("button")).toBeEnabled();
});
it("leaves the form usable when both lookups fail", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-key");
  window.google = maps(
    vi.fn((_request, callback) => callback([], "REQUEST_DENIED")),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw Error("offline");
    }),
  );
  const { LocationPicker } = await import("./location-picker");
  const changed = vi.fn();
  render(<LocationPicker value={empty} onChange={changed} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Use my current location" }),
  );
  await waitFor(() =>
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 30,
        lng: 74,
        addressLine1: "",
        postalCode: "",
      }),
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Please check and complete",
  );
  expect(screen.getByRole("button")).toBeEnabled();
});
it("waits for the async Maps callback rather than the script load event", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-key");
  const { LocationPicker } = await import("./location-picker");
  render(<LocationPicker value={empty} onChange={vi.fn()} />);
  const script = document.querySelector('script[src*="maps.googleapis.com"]')!;
  fireEvent.load(script);
  expect(screen.getByText("Loading map…")).toBeInTheDocument();
  window.google = maps();
  await act(async () => window.__smSignupMapsLoaded!());
  await waitFor(() =>
    expect(screen.queryByText("Loading map…")).not.toBeInTheDocument(),
  );
});
it("does not send a location request after permission denial", async () => {
  getPosition.mockImplementation((_success, error) =>
    error!({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError),
  );
  vi.stubGlobal("fetch", vi.fn());
  const { LocationPicker } = await import("./location-picker");
  render(<LocationPicker value={empty} onChange={vi.fn()} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Use my current location" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("permission was denied");
  expect(fetch).not.toHaveBeenCalled();
});

it("does not send a chosen map pin to the current-device fallback", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-key");
  const google = maps(
    vi.fn((_request, callback) => callback([], "REQUEST_DENIED")),
  );
  window.google = google;
  vi.stubGlobal("fetch", vi.fn());
  const { LocationPicker } = await import("./location-picker");
  const changed = vi.fn();
  render(<LocationPicker value={empty} onChange={changed} />);
  await waitFor(() => expect(google.maps.Map).toHaveBeenCalled());
  const click =
    google.maps.Map.mock.results[0].value.addListener.mock.calls.find(
      (call: unknown[]) => call[0] === "click",
    )![1];
  await act(async () => click({ latLng: { lat: () => 31, lng: () => 75 } }));
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ lat: 31, lng: 75 }),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("does not overwrite a newer pin suggestion with an older response", async () => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", "test-key");
  const geocode = vi.fn();
  const google = maps(geocode);
  window.google = google;
  const { LocationPicker } = await import("./location-picker");
  const changed = vi.fn();
  render(<LocationPicker value={empty} onChange={changed} />);
  await waitFor(() => expect(google.maps.Map).toHaveBeenCalled());
  const click =
    google.maps.Map.mock.results[0].value.addListener.mock.calls.find(
      (call: unknown[]) => call[0] === "click",
    )![1];
  await act(async () => {
    click({ latLng: { lat: () => 30, lng: () => 74 } });
    click({ latLng: { lat: () => 31, lng: () => 75 } });
  });
  await act(async () => geocode.mock.calls[1][1](result, "OK"));
  await act(async () => geocode.mock.calls[0][1](result, "OK"));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith(
    expect.objectContaining({ lat: 31, lng: 75 }),
  );
});
