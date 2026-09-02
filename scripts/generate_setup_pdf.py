#!/usr/bin/env python3
"""Generate the copyable AUTOBOT setup guide included with releases."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "OPEN-FIRST-AUTOBOT-SETUP-GUIDE.pdf"

INK = colors.HexColor("#172018")
MUTED = colors.HexColor("#627064")
LIME = colors.HexColor("#B8FF5A")
PALE = colors.HexColor("#F3F5EF")
LINE = colors.HexColor("#D2D9CF")
WHITE = colors.white
AMBER = colors.HexColor("#FFF3D6")


def footer(canvas, doc):
    canvas.saveState()
    width, _ = letter
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, 0.48 * inch, width - doc.rightMargin, 0.48 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 0.30 * inch, "AUTOBOT Owned-Event RSVP Lab v0.11.0")
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
        title="AUTOBOT v0.11.0 Second Computer Setup",
        author="AUTOBOT RSVP Lab",
        subject="Copyable Windows and Mac setup instructions",
    )

    styles = getSampleStyleSheet()
    title = ParagraphStyle(
        "Title",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=23,
        leading=26,
        textColor=INK,
        spaceAfter=7,
    )
    subtitle = ParagraphStyle(
        "Subtitle",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=10,
        leading=14,
        textColor=MUTED,
        spaceAfter=11,
    )
    heading = ParagraphStyle(
        "Heading",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=14,
        leading=17,
        textColor=INK,
        spaceBefore=5,
        spaceAfter=5,
    )
    subheading = ParagraphStyle(
        "Subheading",
        parent=styles["Heading3"],
        fontName="Helvetica-Bold",
        fontSize=10.5,
        leading=13,
        textColor=INK,
        spaceBefore=6,
        spaceAfter=4,
    )
    body = ParagraphStyle(
        "Body",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8.8,
        leading=12,
        textColor=INK,
        spaceAfter=4,
    )
    bullet = ParagraphStyle(
        "Bullet",
        parent=body,
        leftIndent=15,
        firstLineIndent=-9,
        bulletIndent=3,
        spaceAfter=3,
    )
    code = ParagraphStyle(
        "Code",
        parent=styles["Code"],
        fontName="Courier",
        fontSize=7.3,
        leading=9.5,
        textColor=colors.HexColor("#F6F8F5"),
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.2,
        leading=11.2,
        textColor=MUTED,
    )
    badge = ParagraphStyle(
        "Badge",
        parent=body,
        alignment=TA_CENTER,
        fontName="Helvetica-Bold",
        fontSize=9,
        leading=11,
        textColor=INK,
        spaceAfter=0,
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
        block = Preformatted(text, code)
        table = Table([[block]], colWidths=[doc.width])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), INK),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#344036")),
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
        table = Table([[Paragraph(text, body)]], colWidths=[doc.width])
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), background),
                    ("BOX", (0, 0), (-1, -1), 0.7, LINE),
                    ("LEFTPADDING", (0, 0), (-1, -1), 12),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 12),
                    ("TOPPADDING", (0, 0), (-1, -1), 9),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 8))

    story.append(Paragraph("AUTOBOT v0.11.0", title))
    story.append(Paragraph("SECOND COMPUTER SETUP - WINDOWS AND MAC", subtitle))
    banner = Table(
        [[Paragraph("COPYABLE COMMANDS", badge), Paragraph("1-20 LAPTOPS", badge), Paragraph("REMOTE EVENT OPENING", badge)]],
        colWidths=[doc.width / 3] * 3,
    )
    banner.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), LIME),
                ("BOX", (0, 0), (-1, -1), 0.7, INK),
                ("INNERGRID", (0, 0), (-1, -1), 0.4, INK),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(banner)
    story.append(Spacer(1, 14))
    callout(
        "<b>Use only for the organizer-owned, approved classroom test event.</b> "
        "POSH login, OTP, CAPTCHA, and any browser permission prompts remain manual."
    )

    h("1. Start enrollment on the main dashboard")
    item("On the main MacBook, open https://autobot-command-center.avgschnook.chatgpt.site")
    item("Enter the dashboard PIN.")
    item("Set the maximum number of new laptops and click <b>Start 2-hour enrollment</b>.")
    item("Keep the displayed enrollment code available. Approve every laptop after it appears.")

    h("2. Install the basics on the new computer")
    item("Install Google Chrome from https://www.google.com/chrome/")
    item("Install the current Node.js LTS release from https://nodejs.org/")
    item("Download the newest AUTOBOT release ZIP from https://github.com/danieleyny/autobot/releases/latest")
    item("Extract the ZIP. Open the folder named AUTOBOT-System-v0.11.0.")

    h("3. Make a quiet Chrome profile")
    item("Create a normal Chrome profile named AUTOBOT Laptop 01. Continue without a Google account.")
    item("Do not use Guest or Incognito mode; unpacked extensions do not run there.")
    item("Paste each address below into Chrome and choose the setting shown.")
    quiet_rows = [
        ("chrome://password-manager/settings", "Offer to save passwords and passkeys: OFF"),
        ("chrome://settings/addresses", "Save and fill addresses: OFF"),
        ("chrome://settings/payments", "Save and fill payment methods: OFF"),
        ("chrome://settings/content/notifications", "Do not allow site notifications"),
        ("chrome://settings/content/popups", "Do not allow pop-ups or redirects"),
        ("chrome://settings/performance", "Always keep posh.vip active"),
    ]
    quiet_table = Table(
        [[Paragraph(f"<font name='Courier'>{url}</font>", small), Paragraph(setting, small)] for url, setting in quiet_rows],
        colWidths=[doc.width * 0.49, doc.width * 0.51],
    )
    quiet_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), PALE),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(quiet_table)

    story.append(PageBreak())
    story.append(Paragraph("WINDOWS SETUP", title))
    p("Use these commands if the setup file does not open when double-clicked.", subtitle)

    h("1. Check Node.js")
    p("Open PowerShell and run:")
    code_box("node --version\nnpm --version")
    callout(
        "If either line says <b>not recognized</b>, install Node.js LTS from https://nodejs.org/, "
        "close PowerShell completely, reopen it, and run the checks again.",
        AMBER,
    )

    h("2. Open PowerShell in the extracted folder")
    p("In File Explorer, open AUTOBOT-System-v0.11.0. Click the address bar, type <b>powershell</b>, and press Enter.")

    h("3. Run the setup assistant")
    code_box(".\\SETUP-WINDOWS.cmd")
    item("Enter the enrollment code from the main dashboard.")
    item("Enter a unique name such as Laptop 01.")
    item("Keep the PowerShell window open during this first session.")

    h("Manual fallback")
    p("If the assistant still does not run, paste these commands one block at a time:")
    code_box(
        "npm install\n\n"
        "npm run device:pair -- `\n"
        "  --controller=https://autobot-command-center.avgschnook.chatgpt.site `\n"
        "  --code=PAIRING_CODE `\n"
        "  --name=\"Laptop 01\"\n\n"
        "npm run device:install\n"
        "npm run device"
    )
    callout("Replace PAIRING_CODE before pressing Enter. Do not include brackets, bold marks, or a copied timestamp.")

    h("4. Load the extension")
    item("Open chrome://extensions and turn on Developer mode.")
    item("Click Load unpacked.")
    item("Select the inner <b>extension</b> folder, not the outer AUTOBOT folder.")
    item("Confirm AUTOBOT Owned-Event RSVP Lab v0.11.0 appears.")

    story.append(PageBreak())
    story.append(Paragraph("MAC SETUP", title))
    p("All commands below are selectable. Paste one command at a time into Terminal.", subtitle)

    h("1. Check Node.js")
    p("Open Terminal and run:")
    code_box("node --version\nnpm --version")
    callout(
        "If Terminal says <b>command not found</b>, install Node.js LTS from https://nodejs.org/. "
        "Close Terminal completely, reopen it, and run the checks again.",
        AMBER,
    )

    h("2. Move Terminal into the AUTOBOT folder")
    p("Type <font name='Courier'>cd</font> followed by one space. Drag the extracted AUTOBOT-System-v0.11.0 folder into Terminal, then press Return.")

    h("3. Run the setup assistant")
    code_box("chmod +x SETUP-MAC.command\n./SETUP-MAC.command")
    item("Enter the enrollment code from the main dashboard.")
    item("Enter a unique name such as Laptop 01.")
    item("Keep Terminal open during this first session.")
    callout(
        "If macOS blocks the file, open System Settings - Privacy & Security and choose Open Anyway "
        "only for the file downloaded from the official AUTOBOT GitHub release.",
        AMBER,
    )

    h("Manual fallback")
    code_box(
        "npm install\n\n"
        "npm run device:pair -- \\\n"
        "  --controller=https://autobot-command-center.avgschnook.chatgpt.site \\\n"
        "  --code=PAIRING_CODE \\\n"
        "  --name=\"Laptop 01\"\n\n"
        "npm run device:install\n"
        "npm run device"
    )
    p("Replace PAIRING_CODE before running the pairing command.", small)

    h("4. Load the extension")
    item("Open chrome://extensions and turn on Developer mode.")
    item("Click Load unpacked and select the inner <b>extension</b> folder.")
    item("Confirm AUTOBOT Owned-Event RSVP Lab v0.11.0 appears.")

    story.append(PageBreak())
    story.append(Paragraph("CONNECT, TEST, AND OPERATE", title))
    p("Complete these steps after the setup assistant and extension are running.", subtitle)

    h("1. Approve the laptop")
    item("Return to the Command Center on the main MacBook.")
    item("Find the new laptop marked Pending and click <b>Approve device</b>.")
    item("Confirm it changes to Online. Pairing remains saved across restarts.")

    h("2. Sign into POSH manually")
    item("On the new laptop, sign into its individual POSH account.")
    item("Complete OTP, CAPTCHA, or Cloudflare checks manually.")
    item("Dismiss cookie, location, tutorial, and other one-time prompts.")

    h("3. Open a new event across the fleet")
    item("In the Command Center, paste the organizer-owned POSH event URL.")
    item("Click <b>Select online</b> to include every connected laptop, or select only the laptops participating.")
    item("Click <b>Open event on selected devices</b>. Keep Chrome open; allow up to 30 seconds.")
    item("After the event loads, click <b>Use event open on selected devices</b> to capture its exact title.")
    item("Confirm the AUTOBOT panel appears and <b>Allow command center</b> remains checked.")

    h("4. Rehearsal before live mode")
    item("Click Select ready and choose Rehearsal.")
    item("Rehearsal checks the event and free RSVP without selecting a ticket or submitting.")
    item("Review the dashboard overview: Passed/Confirmed, Waiting/Review, and Issues.")

    h("5. Live test")
    item("Enter the event password and release time once in the Command Center.")
    item("Select only the laptops participating in this test.")
    item("Complete the ownership and written-permission confirmations, then activate the selected devices.")
    item("Each selected device receives one independent, one-use lease. Failed devices are not automatically retried.")
    callout(
        "The POSH Stay in the loop email/text dialog is a successful post-RSVP state. "
        "AUTOBOT v0.11.0 recognizes it as confirmed without choosing either marketing option."
    )

    h("6. Fleet directory and shutdown")
    item("Use the Fleet directory tab to store optional account email, phone, and a secondary description.")
    item("These details remain in the PIN-protected dashboard and are not sent to laptops.")
    item("Before removing a computer, stop any active run, choose Remove and revoke, uninstall startup if needed, remove the extension, and delete the extracted folder.")

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    build_pdf()
