#!/usr/bin/env python3
"""Generate the copyable AUTOBOT multi-profile host setup guide."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "OPEN-FIRST-AUTOBOT-PROFILE-HOST-GUIDE.pdf"

INK = colors.HexColor("#172018")
MUTED = colors.HexColor("#627064")
LIME = colors.HexColor("#B8FF5A")
PALE = colors.HexColor("#F3F5EF")
LINE = colors.HexColor("#D2D9CF")
AMBER = colors.HexColor("#FFF3D6")
WHITE = colors.white


def footer(canvas, doc):
    canvas.saveState()
    width, _ = letter
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, 0.48 * inch, width - doc.rightMargin, 0.48 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.30 * inch, "AUTOBOT Multi-Profile Host v0.13.0")
    canvas.drawRightString(width - doc.rightMargin, 0.30 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build_pdf():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=letter,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.58 * inch,
        bottomMargin=0.68 * inch,
        title="AUTOBOT v0.13.0 Multi-Profile Host Setup",
        author="AUTOBOT RSVP Lab",
        subject="Copyable Windows and Mac multi-profile host instructions",
    )
    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=25,
        leading=28,
        textColor=INK,
        alignment=TA_CENTER,
        spaceAfter=8,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=11,
        leading=15,
        textColor=MUTED,
        alignment=TA_CENTER,
        spaceAfter=14,
    )
    heading = ParagraphStyle(
        "Heading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=18,
        textColor=INK,
        spaceBefore=8,
        spaceAfter=7,
    )
    subheading = ParagraphStyle(
        "Subheading",
        parent=styles["Heading3"],
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=14,
        textColor=INK,
        spaceBefore=6,
        spaceAfter=4,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.2,
        leading=12.2,
        textColor=INK,
        spaceAfter=4.5,
    )
    bullet = ParagraphStyle(
        "Bullet",
        parent=body,
        leftIndent=14,
        firstLineIndent=-8,
        bulletIndent=0,
        spaceAfter=3,
    )
    code = ParagraphStyle(
        "Code",
        fontName="Courier",
        fontSize=7.8,
        leading=10.8,
        textColor=colors.HexColor("#F6F8F5"),
    )

    story = []

    def p(text, style=body):
        story.append(Paragraph(text, style))

    def h(text):
        story.append(Paragraph(text, heading))

    def sh(text):
        story.append(Paragraph(text, subheading))

    def item(text):
        story.append(Paragraph(text, bullet, bulletText="-"))

    def code_box(text):
        table = Table([[Preformatted(text, code)]], colWidths=[7.05 * inch])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), INK),
                    ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#344036")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 10),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 7))

    def callout(text, background=PALE):
        table = Table([[Paragraph(text, body)]], colWidths=[7.05 * inch])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), background),
                    ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                    ("LEFTPADDING", (0, 0), (-1, -1), 11),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 11),
                    ("TOPPADDING", (0, 0), (-1, -1), 8),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 7))

    story.append(Paragraph("AUTOBOT v0.13.0", title))
    story.append(Paragraph("MULTI-PROFILE HOST - WINDOWS AND MAC", subtitle))
    badges = Table(
        [[Paragraph("1-4 ISOLATED PROFILES", body), Paragraph("ONE-CLICK LAUNCH", body), Paragraph("CLASSIC MODE PRESERVED", body)]],
        colWidths=[2.35 * inch] * 3,
    )
    badges.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), LIME),
                ("BOX", (0, 0), (-1, -1), 0.6, INK),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, INK),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(badges)
    story.append(Spacer(1, 10))
    callout(
        "<b>This is an optional secondary system.</b> The original one-computer setup remains available and unchanged. Do not remove a working classic pairing. Use only separate authorized accounts and the organizer-owned approved test event.",
        AMBER,
    )

    h("What this creates")
    p("One physical computer runs a profile-host bridge plus 1-4 persistent Chrome workers. Each worker has its own POSH login cookies, AUTOBOT identity, private local extension copy, encrypted password channel, slot assignment, and one-use execution lease.")
    item("The classic bridge remains on 127.0.0.1:4181.")
    item("The new profile host uses 127.0.0.1:4182 and can coexist with classic mode.")
    item("After one-time setup, the Command Center can launch every worker on a host with one click.")
    item("POSH login, OTP, CAPTCHA, security, and consent prompts remain manual.")

    h("Before setup")
    item("Install current Google Chrome from https://www.google.com/chrome")
    item("Install current Node.js LTS from https://nodejs.org")
    item("Download and extract the v0.13.0 release ZIP. Do not run setup from inside the ZIP.")
    item("In Command Center > Operations, start a 48-hour enrollment with one use per planned worker.")
    item("Choose 1-4 workers. Start with 3 on an 8 GB computer and 4 on a 16 GB computer.")
    item("Close normal Chrome windows for the smoothest first-time setup.")

    h("The one-time Chrome step")
    p("Chrome requires an unpacked extension to be loaded manually. The assistant prints one private numbered extension path per worker and opens the matching Chrome profile windows. Load each numbered folder only into the matching numbered profile.")
    callout("<b>Never load the ordinary extracted extension folder into a profile worker.</b> Never reuse Profile 1's private extension folder in Profile 2. The printed worker number and Chrome window must match.")

    story.append(PageBreak())
    story.append(Paragraph("WINDOWS SETUP", title))
    story.append(Paragraph("Run the assistant or use the copyable fallback commands", subtitle))

    h("1. Check Node.js")
    p("Open Command Prompt or PowerShell in the extracted AUTOBOT folder and run:")
    code_box("node --version\nnpm --version")
    p("If either command is not recognized, install Node.js LTS, close the terminal completely, reopen it in the extracted folder, and repeat the checks.")

    h("2. Run the Windows profile-host assistant")
    code_box(".\\SETUP-PROFILE-HOST-WINDOWS.cmd")
    item("Enter the 48-hour enrollment code exactly as displayed.")
    item("Enter one label for the physical computer, such as Studio PC 1.")
    item("Enter a worker count from 1 through 4.")
    p("The assistant installs files, pairs the workers, registers automatic startup, prints each private extension path, opens the Chrome profiles, and keeps the host bridge running.")

    sh("Manual fallback")
    code_box(
        "npm install\n\n"
        "npm run profiles:setup -- `\n"
        "  --controller=https://autobot-command-center.avgschnook.chatgpt.site `\n"
        "  --code=ENROLLMENT_CODE `\n"
        "  --name=\"Studio PC 1\" `\n"
        "  --workers=4\n\n"
        "npm run profiles:install\n"
        "npm run profiles:host"
    )
    p("Replace ENROLLMENT_CODE and change the name or worker count before running the block.")

    h("3. Configure every numbered Chrome window")
    item("Open chrome://extensions and turn on Developer mode.")
    item("Click Load unpacked and select the matching numbered path printed by the terminal.")
    item("Open the AUTOBOT extension popup and confirm the host label and Profile number.")
    item("Sign into that profile's own POSH account and complete manual checks.")
    item("Repeat for every numbered window, then approve every worker in Operations.")

    p("Complete the disruptive-prompt settings on the final page in every profile.")

    story.append(PageBreak())
    story.append(Paragraph("MAC SETUP", title))
    story.append(Paragraph("Run the assistant or use the copyable fallback commands", subtitle))

    h("1. Check Node.js")
    p("Open Terminal in the extracted AUTOBOT folder and run:")
    code_box("node --version\nnpm --version")
    p("If Terminal says command not found, install Node.js LTS, close Terminal completely, reopen it, and repeat the checks.")

    h("2. Run the Mac profile-host assistant")
    code_box("chmod +x SETUP-PROFILE-HOST-MAC.command\n./SETUP-PROFILE-HOST-MAC.command")
    item("Enter the 48-hour enrollment code exactly as displayed.")
    item("Enter one label for the physical computer, such as Studio Mac 1.")
    item("Enter a worker count from 1 through 4.")
    p("If macOS blocks the file, open System Settings > Privacy &amp; Security and choose Open Anyway only for the file from the official AUTOBOT release.")

    sh("Manual fallback")
    code_box(
        "npm install\n\n"
        "npm run profiles:setup -- \\\n"
        "  --controller=https://autobot-command-center.avgschnook.chatgpt.site \\\n"
        "  --code=ENROLLMENT_CODE \\\n"
        "  --name=\"Studio Mac 1\" \\\n"
        "  --workers=4\n\n"
        "npm run profiles:install\n"
        "npm run profiles:host"
    )

    h("3. Complete every numbered profile")
    p("Use the same Chrome extension, POSH login, approval, and prompt-suppression checklist shown on the Windows page. The steps are identical inside Chrome.")

    story.append(PageBreak())
    story.append(Paragraph("EVERY LATER SESSION", title))
    story.append(Paragraph("One-click launch, rehearsal, recovery, and safe operation", subtitle))
    item("Sign into the physical computer. The profile-host bridge starts automatically.")
    item("Open Command Center > Profile hosts and confirm the host channels are online.")
    item("Click Launch all workers. Allow up to 15 seconds for an idle host to receive the command.")
    item("Resolve manual POSH prompts, then click Select for operations.")
    item("Send the current event URL, check readiness, and run a rehearsal first.")
    item("For live mode, keep every selected event tab visible through release.")

    h("Turn off disruptive prompts in every profile")
    item("chrome://password-manager/settings - Offer to save passwords and passkeys: OFF")
    item("chrome://settings/content/notifications - Do not allow sites to send notifications")
    item("chrome://settings/content/popups - Do not allow pop-ups or redirects")
    item("chrome://settings/payments - Save and fill payment methods: OFF")
    item("chrome://settings/addresses - Save and fill addresses: OFF")

    h("Recovery and validation")
    code_box("npm run test:profiles")
    item("If the host is offline, rerun npm run profiles:host from the extracted folder.")
    item("If only one browser is closed, use Launch all workers again.")
    item("Rerunning the setup assistant refreshes worker extension files without deleting pairings or POSH profile data.")
    item("If a worker was revoked, create a new enrollment code and run the replacement command below. Its Chrome profile and POSH cookies stay in place.")
    code_box("npm run profiles:setup -- --code=NEW_CODE --replace-worker=2 --no-onboarding")

    callout("<b>Operational boundary:</b> Multiple profiles do not bypass POSH limits, queues, verification, or account rules. They only replace multiple physical laptops for the approved test configuration.", AMBER)

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    build_pdf()
