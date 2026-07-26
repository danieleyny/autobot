# AUTOBOT RSVP Lab

A Chrome extension for a classroom demonstration using an organizer-owned,
free POSH test event.

## Install on the school computer

1. Click the green **Code** button on this GitHub page.
2. Click **Download ZIP**.
3. Double-click the downloaded ZIP to extract it.
4. Open Google Chrome and enter `chrome://extensions` in the address bar.
5. Turn on **Developer mode** in the upper-right corner.
6. Click **Load unpacked**.
7. Select the extracted `autobot-main` folder—the folder containing
   `manifest.json`.
8. Open the POSH test-event page and refresh it once.
9. Confirm that the AUTOBOT panel appears and displays **v0.6.2**.

For the demonstration checklist, open
[START-HERE.txt](START-HERE.txt).

## Updating AUTOBOT

Chrome's **Reload** button reloads the extension files already stored on that
computer. It does not download updates from GitHub.

When a new version is published:

1. Return to this repository and choose **Code → Download ZIP** again.
2. Extract the new download.
3. Open `chrome://extensions`.
4. Remove the older AUTOBOT extension.
5. Click **Load unpacked** and select the new `autobot-main` folder.
6. Confirm the new version number in the AUTOBOT panel.

This replacement method is simplest and avoids accidentally mixing files from
two versions.

## Important

- Sign into POSH normally and complete OTP or Cloudflare checks manually.
- This repository contains no POSH password, login session, OTP, browser data,
  or previous test history.
- Use the extension only with the organizer-owned classroom test event.
- If **Developer mode** or **Load unpacked** is unavailable, the school has
  probably restricted unpacked Chrome extensions. Ask the professor or school
  IT department to approve it; do not bypass the restriction.

## Remove after the demonstration

Open `chrome://extensions` and click **Remove** under
**AUTOBOT Owned-Event RSVP Lab**.
