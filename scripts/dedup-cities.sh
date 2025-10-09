#!/usr/bin/env bash
# Usage: ./duplicate-cities.sh path/to/us_metro_model.json
jq 'unique_by({name,lat,lng}) | sort_by(.name)' ../web/public/city-model.json > ../web/public/city-model.clean.json

