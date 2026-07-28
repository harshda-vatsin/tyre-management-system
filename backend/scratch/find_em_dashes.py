import os

def find_em_dashes(directory):
    for root, dirs, files in os.walk(directory):
        if "node_modules" in root or ".next" in root:
            continue
        for file in files:
            if file.endswith((".jsx", ".js", ".css")):
                path = os.path.join(root, file)
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        lines = f.readlines()
                    for idx, line in enumerate(lines):
                        if "—" in line:
                            # print relative path
                            rel_path = os.path.relpath(path, directory)
                            print(f"{rel_path}:{idx+1}: {line.strip()}")
                except Exception as e:
                    pass

if __name__ == "__main__":
    find_em_dashes(r"c:\Users\Harshda\Desktop\tyre management\ebtms\frontend")
