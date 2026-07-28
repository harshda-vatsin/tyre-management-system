import sqlite3

def query_local_db():
    conn = sqlite3.connect(r"c:\Users\Harshda\Desktop\tyre management\ebtms\backend\data\ebtms.sqlite")
    cursor = conn.cursor()
    
    # 1. Tyres
    cursor.execute("SELECT COUNT(*) FROM tyres")
    print("Local Tyres count:", cursor.fetchone()[0])
    
    # 2. Events
    cursor.execute("SELECT COUNT(*) FROM tyre_events")
    print("Local Events count:", cursor.fetchone()[0])
    
    # 3. Alerts
    cursor.execute("SELECT COUNT(*) FROM alerts")
    print("Local Alerts count:", cursor.fetchone()[0])
    
    cursor.execute("SELECT * FROM alerts")
    for r in cursor.fetchall():
        print("Alert:", r)
        
    conn.close()

if __name__ == '__main__':
    query_local_db()
