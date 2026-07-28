import os

replacements = {
    "app/(protected)/admin/thresholds/page.jsx": [
        ("|| '—'", "|| '-'"),
        ("Edit Threshold —", "Edit Threshold:"),
        ("Override —", "Override:")
    ],
    "app/(protected)/admin/users/page.jsx": [
        ("|| '—'", "|| '-'")
    ],
    "app/(protected)/alerts/page.jsx": [
        ("// Non-fatal — summary", "// Non-fatal: summary")
    ],
    "app/(protected)/alerts/[id]/page.jsx": [
        ("|| '—'", "|| '-'"),
        (": '—'}", ": '-' }")
    ],
    "app/(protected)/audit-log/page.jsx": [
        ("— Item ID", "| Item ID"),
        ("|| '—'", "|| '-'")
    ],
    "app/(protected)/batch-inspection/page.jsx": [
        ("?? '—'}—{", "?? '-'} to {")
    ],
    "app/(protected)/buses/page.jsx": [
        ("// to trimmed, uppercase form — mirrors", "// to trimmed, uppercase form, mirroring"),
        ("// — it's inherited", "//: it's inherited"),
        ("// — so it's shown", "//, so it's shown")
    ],
    "app/(protected)/inspection-compliance/page.jsx": [
        ("// Non-fatal — summary", "// Non-fatal: summary"),
        ("|| '—'", "|| '-'"),
        (": '—'}", ": '-' }")
    ],
    "app/(protected)/tyres/[id]/page.jsx": [
        ("|| '—'", "|| '-'"),
        ("|| '—'", "|| '-'")
    ],
    "components/RowActionsMenu.jsx": [
        ("— per the CSS", ", per the CSS")
    ]
}

def do_replacements(base_dir):
    for rel_path, pairs in replacements.items():
        full_path = os.path.join(base_dir, rel_path.replace("/", os.sep))
        if not os.path.exists(full_path):
            print(f"Warning: file {full_path} not found.")
            continue
        
        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        modified = False
        for old, new in pairs:
            if old in content:
                content = content.replace(old, new)
                modified = True
            # Let's try replacing raw em-dash as well
            raw_old = old.replace("—", "—")
            if raw_old in content:
                content = content.replace(raw_old, new)
                modified = True
                
        if modified:
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"Successfully processed replacements for {rel_path}")

if __name__ == "__main__":
    do_replacements(r"c:\Users\Harshda\Desktop\tyre management\ebtms\frontend")
