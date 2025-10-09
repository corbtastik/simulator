#!/usr/bin/env python3
import sys, json, pandas as pd

def pop_to_weight(pop):
    if pop < 20000: return 1
    if pop < 50000: return 2
    if pop < 120000: return 3
    if pop < 250000: return 4
    if pop < 500000: return 5
    if pop < 1000000: return 7
    if pop < 3000000: return 10
    if pop < 8000000: return 16
    return 23

def weight_to_sigma(w):
    if w <= 2: return 5
    if w <= 5: return 10
    if w <= 9: return 12
    if w <= 16: return 14
    return 16

def main(in_csv, out_json):
    # Try with no header first (your CSV pattern)
    df = pd.read_csv(in_csv, header=None, names=["city","lat","lon","population"])
    # Fallback if it *does* have headers
    if not pd.api.types.is_numeric_dtype(df["lat"]):
        df = pd.read_csv(in_csv)
        df.columns = [c.strip().lower() for c in df.columns]
        df = df.rename(columns={"city":"city","name":"city","latitude":"lat","lat":"lat",
                                "longitude":"lon","lon":"lon",
                                "population":"population","pop":"population"})
        df = df[["city","lat","lon","population"]]

    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df["population"] = pd.to_numeric(df["population"], errors="coerce")
    df = df.dropna(subset=["city","lat","lon","population"])

    # If duplicates exist, keep the largest population entry per city
    df = df.sort_values("population", ascending=False).drop_duplicates(subset=["city"]).sort_index()

    df["weight"] = df["population"].apply(pop_to_weight).astype(int)
    df["sigmaKm"] = df["weight"].apply(weight_to_sigma).astype(int)

    out = [
        {"name": str(r.city),
         "lat": round(float(r.lat), 6),
         "lng": round(float(r.lon), 6),
         "weight": int(r.weight),
         "sigmaKm": int(r.sigmaKm)}
        for r in df.itertuples(index=False)
    ]
    with open(out_json, "w") as f:
        json.dump(out, f, indent=2)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python csv_to_cities.py <in_csv> <out_json>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
