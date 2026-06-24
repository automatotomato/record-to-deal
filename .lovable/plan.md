## Goal

Most parked counties were disabled because they have no free **image** recorder portal. We don't need images — text deed-index search is enough for scout. Seed the known free text index URL for each non-NV parked county, re-enable them, and slightly broaden scan-sources so government text indexes count as valid sources.

## Counties to re-enable (text recorder URLs)

Non-NV parked counties + the URL to seed. All are free public text/deed-index search portals (no paywall, no login):

| State | County | Text recorder URL |
|---|---|---|
| CA | Alameda | https://rechart1.acgov.org/ |
| CA | Los Angeles | https://www.lavote.gov/home/recorder/grantor-grantee-index |
| CA | Orange | https://cr.ocgov.com/grantorgranteesearch/ |
| CA | Riverside | https://riverside.asrclkrec.com/grantorgranteesearch/ |
| CA | Sacramento | https://eros.saccounty.gov/ |
| CA | San Diego | https://arcc-acclaim.sandiegocounty.gov/AcclaimWeb/ |
| CA | San Francisco | https://recorder.sfgov.org/web/login.aspx (public guest search) |
| CA | San Mateo | https://crwebpub.smcacre.org/CRSearch/ |
| CA | Santa Clara | https://crsearch.sccgov.org/ |
| CO | Arapahoe | https://recording.arapahoegov.com/RecordingSearch/ |
| CO | Denver | https://recordingsearch.denvergov.org/ |
| HI | Honolulu | https://boc.ehawaii.gov/docsearch/nameSearch.html |
| IL | Cook | https://crs.cookcountyclerkil.gov/Search |
| IL | DuPage | https://recorder.dupageco.org/RecorderEsearch/ |
| IL | Lake | https://lcrod.lakecountyil.gov/ |
| MA | Middlesex | https://www.masslandrecords.com/MiddlesexSouth/ |
| MA | Norfolk | https://www.norfolkdeeds.org/ |
| MA | Suffolk | https://www.masslandrecords.com/Suffolk/ |
| MN | Ramsey | https://rrinfo.co.ramsey.mn.us/ |
| NJ | Bergen | https://oprs.co.bergen.nj.us/Or_Web1/ |
| NJ | Essex | https://acclaim.essexregister.com/AcclaimWeb/ |
| NJ | Hudson | https://acclaim.hcnj.us/AcclaimWeb/ |
| NJ | Middlesex | https://clerk.middlesexcountynj.gov/Public/ |
| NJ | Monmouth | https://oprs.co.monmouth.nj.us/oprs/ |
| NY | Bronx / Kings / NY / Queens | https://a836-acris.nyc.gov/CP/ (ACRIS — covers all 4 NYC boroughs) |
| NY | Nassau | https://i2f.uslandrecords.com/NY/Nassau/ |
| NY | Suffolk | https://suffolkcountyny.gov/Departments/County-Clerk/Online-Records |
| NY | Westchester | https://wro.westchesterclerk.com/ |
| OR | Clackamas | https://recordings.clackamas.us/recordings/ |
| OR | Washington | https://recordings.co.washington.or.us/Recordings/ |
| TX | Bexar | https://apps.bexar.org/countyclerk/officialpublicrecords/ |
| TX | Dallas | https://www.dallascounty.org/government/county-clerk/recording/ |
| TX | Harris | https://www.cclerk.hctx.net/Applications/WebSearch/RP_R.aspx |
| WA | King | https://recordsearch.kingcounty.gov/LandmarkWeb/ |

Already-enabled MN Hennepin: just flip `enabled = true`.

## What stays parked
- **All NV counties** (Clark, Washoe, Carson City, Douglas, Elko, Lyon, Nye) — per current strategy, we don't source from Nevada (no tax arbitrage to pitch).

## Code change (scan-sources)

`buildQueries` currently emits one query. Expand it to two so text-only indexes (which often hide deed language inside a search-results page) still surface:

```ts
return [
  `site:${recorderHost} (deed OR "warranty deed" OR "grant deed" OR "special warranty" OR "deed of trust") grantor grantee`,
  `site:${recorderHost} grantor grantee ${(_county || "").toLowerCase()}`,
];
```

No other code changes — pipeline already filters for commercial / price floor / confidence, so re-enabling won't introduce residential noise.

## Steps

1. Migration: `UPDATE counties SET recorder_index_url = '<url>', enabled = true WHERE state = '<s>' AND county = '<c>'` for every row in the table above. Hennepin gets only `enabled = true`.
2. Edit `supabase/functions/scan-sources/index.ts` `buildQueries` to return the 2-query variant above.
3. Deploy `scan-sources`.
4. Trigger `run_scout_cron()` and watch `pipeline_jobs` + `leads` for a few minutes to confirm new counties produce candidates (and that confidence/price filters still drop residential).

## Out of scope
- Re-enabling NV counties.
- Writing new per-county scrapers (Travis-style adapters).
- Changing scan-external rotation.
