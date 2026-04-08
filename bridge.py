import sys
import json
from miio import Device

def main():
    ip = sys.argv[1]
    token = sys.argv[2]
    action = sys.argv[3]       # "get_properties" o "set_properties"
    payload_str = sys.argv[4]  # El array JSON en string

    try:
        dev = Device(ip, token)
        payload = json.loads(payload_str)
        res = dev.send(action, payload)
        print(json.dumps(res)) # Escupimos la respuesta pura a Go
    except Exception as e:
        print(f'{{"error": "{str(e)}"}}')
        sys.exit(1)

if __name__ == "__main__":
    main()