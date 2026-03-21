output "api_url" {
  description = "URL of the BIM Convert API"
  value       = "http://${azurerm_public_ip.main.ip_address}:8000"
}

output "vm_public_ip" {
  description = "Public IP of the VM"
  value       = azurerm_public_ip.main.ip_address
}

output "rdp_command" {
  description = "RDP connection command"
  value       = "mstsc /v:${azurerm_public_ip.main.ip_address}"
}
