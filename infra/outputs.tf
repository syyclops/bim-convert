output "api_url" {
  description = "URL of the BIM Convert API"
  value       = "https://${var.domain}"
}

output "vm_public_ip" {
  description = "Public IP of the VM — point your DNS A record here"
  value       = azurerm_public_ip.main.ip_address
}

output "rdp_command" {
  description = "RDP connection command"
  value       = "mstsc /v:${azurerm_public_ip.main.ip_address}"
}

output "dns_instructions" {
  description = "DNS setup instructions"
  value       = "Create an A record: ${var.domain} → ${azurerm_public_ip.main.ip_address}"
}
